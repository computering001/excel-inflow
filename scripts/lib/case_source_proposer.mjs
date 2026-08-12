import { classifyStatementLine } from "./statement_classifier.mjs";
import { faceStatementManifestDigest } from "./face_statement_manifest.mjs";

const SECTIONS = Object.freeze(["income_statement", "cash_flow"]);

const CORE_ROLE_ALIASES = Object.freeze({
  income_statement: Object.freeze({
    revenue: ["revenue", "revenues", "turnover", "net sales", "total revenue"],
    gross_profit: ["gross profit"],
    operating_profit: ["operating profit", "operating income"],
    ebit: ["ebit", "earnings before interest and tax", "earnings before interest and taxes"],
    adjusted_ebitda: ["adjusted ebitda", "core ebitda", "underlying ebitda"],
    depreciation_and_amortisation: [
      "depreciation and amortisation",
      "depreciation amortisation and impairment",
      "depreciation amortization and impairment",
      "depreciation and amortization",
    ],
    pre_tax_income: [
      "profit before tax",
      "profit before taxation",
      "income before tax",
      "income before income taxes",
      "pre tax profit",
    ],
    tax_expense: ["income tax expense", "tax expense", "taxation", "income taxes"],
    effective_tax_rate: ["effective tax rate"],
    net_income: [
      "net income",
      "net profit",
      "profit for the year",
      "profit for the period",
      "profit after tax",
      "profit after taxation",
    ],
  }),
  cash_flow: Object.freeze({
    cash_flow_net_income: [
      "net income",
      "net profit",
      "profit for the year",
      "profit for the period",
      "profit after taxation",
    ],
    cash_flow_profit_before_tax: [
      "profit before tax",
      "profit before taxation",
      "income before tax",
      "income before taxation",
    ],
    cash_from_operations: [
      "net cash from operating activities",
      "net cash provided by operating activities",
      "cash flow from operating activities",
    ],
    cash_generated_from_operations: ["cash generated from operations"],
    cash_from_investing: [
      "net cash from investing activities",
      "net cash used in investing activities",
      "cash flow from investing activities",
    ],
    cash_from_financing: [
      "net cash from financing activities",
      "net cash used in financing activities",
      "cash flow from financing activities",
    ],
    net_change_in_cash: [
      "net increase in cash and cash equivalents",
      "net decrease in cash and cash equivalents",
      "net change in cash and cash equivalents",
      "increase in cash and cash equivalents",
      "decrease in cash and cash equivalents",
      "net increase decrease in cash and cash equivalents",
    ],
    opening_cash: [
      "cash and cash equivalents at beginning of year",
      "cash and cash equivalents at beginning of period",
      "cash and cash equivalents at start of year",
    ],
    ending_cash: [
      "cash and cash equivalents at end of year",
      "cash and cash equivalents at end of period",
      "cash and cash equivalents at year end",
      "ending cash",
    ],
    cash_flow_da: [
      "depreciation and amortisation",
      "depreciation and amortization",
      "depreciation amortisation and impairment",
      "depreciation amortization and impairment",
    ],
    cash_flow_tax_addback: [
      "income tax charge",
      "income tax expense",
      "tax charge",
      "tax expense",
    ],
    lease_principal: [
      "payment of lease liabilities",
      "payments of lease liabilities",
      "repayment of lease liabilities",
      "repayments of lease liabilities",
      "lease principal payments",
      "lease principal repayment",
    ],
    capex: [
      "capital expenditure",
      "capital expenditures",
      "purchase of property plant and equipment",
      "purchases of property plant and equipment",
      "additions to property plant and equipment",
    ],
    dividends: ["dividends paid", "dividend paid"],
    share_buybacks: [
      "purchase of own shares",
      "purchases of own shares",
      "repurchase of shares",
      "share repurchases",
    ],
  }),
});

function normalise(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll(/&/g, " and ")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

function sanitizeRowId(value, used) {
  let base = normalise(value).replaceAll(" ", "_").replace(/^[^a-z]+/, "");
  if (!base) base = "statement_line";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function coreRole(section, label) {
  const target = normalise(label);
  for (const [role, aliases] of Object.entries(CORE_ROLE_ALIASES[section] ?? {})) {
    if (aliases.some((alias) => normalise(alias) === target)) return role;
  }
  return null;
}

function contextualRole(section, row, role) {
  // An income-statement D&A expense and the positive EBITDA-bridge input are
  // economically different nodes. Preserve that distinction from the filed
  // sign instead of allowing a negative expense to become the bridge add-back.
  if (section === "income_statement" && role === "depreciation_and_amortisation") {
    const values = (row?.values ?? [])
      .filter((value) => value !== null && value !== "" && Number.isFinite(Number(value)))
      .map(Number);
    if (values.length > 0 && values.some((value) => value < 0) && values.every((value) => value <= 0)) {
      return "is_da_expense";
    }
  }
  return role;
}

function manifestRows(caseEvidence, section) {
  return (caseEvidence?.face_statement_manifests?.[section] ?? [])
    .flatMap((manifest) => (manifest.rows ?? []).map((row) => ({ manifest, row })));
}

function manifestReferences(caseEvidence, section) {
  return (caseEvidence?.face_statement_manifests?.[section] ?? []).map((manifest) => ({
    source_id: manifest.source_id,
    digest: manifest.rows_sha256 ?? faceStatementManifestDigest(manifest),
  }));
}

function valueLess(row) {
  return !Array.isArray(row?.values) || row.values.every((value) => value === null || value === "");
}

function proposeSection(caseEvidence, section, used) {
  const lines = manifestRows(caseEvidence, section);
  const rowIdBySource = new Map();
  const roleBySource = new Map();
  const brokerMetrics = new Set(
    Object.keys(caseEvidence?.lanes?.broker_pack?.metrics ?? {}),
  );

  for (const { row } of lines) {
    const deterministicRole = contextualRole(
      section,
      row,
      coreRole(section, row.raw_label),
    );
    const classification = classifyStatementLine({
      label: row.raw_label,
      section,
      parent_label: null,
      neighbouring_labels: [],
    });
    const role = deterministicRole ??
      (classification.status === "accepted" ? classification.classified_role : null);
    roleBySource.set(row.source_line_id, role);
    rowIdBySource.set(
      row.source_line_id,
      sanitizeRowId(role ?? row.raw_label ?? row.source_line_id, used),
    );
  }

  return lines.map(({ row }) => {
    const role = roleBySource.get(row.source_line_id);
    const entry = {
      source_line_id: row.source_line_id,
      row_id: rowIdBySource.get(row.source_line_id),
      disposition: "keep",
      ...(role ? { role } : {}),
      ...(role && brokerMetrics.has(role) ? { broker_metric_id: role } : {}),
      ...(row.parent_source_line_id
        ? { parent_source_line_id: row.parent_source_line_id }
        : {}),
      ...(valueLess(row) ? { header: true } : {}),
    };
    return entry;
  });
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Compile the declarations-only case-source surface from the immutable filing
 * manifests. Every filed line is retained exactly once. High-confidence roles
 * are declared; unfamiliar issuer-specific lines remain visible under their
 * exact filed label and proceed to the forecast authority graph.
 */
export function proposeCaseSource({ declarations = {}, caseEvidence, evidenceRunSha256 = null }) {
  if (!caseEvidence?.face_statement_manifests) {
    throw new Error("Case-source proposal requires sealed face-statement manifests.");
  }
  if (!declarations?.identity?.issuer_name || !declarations?.identity?.reporting_currency) {
    throw new Error("Case-source proposal requires issuer_name and reporting_currency declarations.");
  }
  for (const section of SECTIONS) {
    if ((caseEvidence.face_statement_manifests?.[section] ?? []).length === 0) {
      throw new Error(`Case-source proposal requires at least one ${section} manifest.`);
    }
  }
  const usedRowIds = new Set();
  return {
    schema_version: "case-source-v1",
    identity: clone(declarations.identity),
    evidence_refs: {
      evidence_run_sha256: evidenceRunSha256,
      ...(declarations.evidence_refs?.filings
        ? { filings: clone(declarations.evidence_refs.filings) }
        : {}),
      face_statement_manifests: Object.fromEntries(
        SECTIONS.map((section) => [section, manifestReferences(caseEvidence, section)]),
      ),
      ...(declarations.evidence_refs?.broker_pack_sha256 !== undefined
        ? { broker_pack_sha256: declarations.evidence_refs.broker_pack_sha256 }
        : {}),
      ...(declarations.evidence_refs?.dcs_projection_sha256 !== undefined
        ? { dcs_projection_sha256: declarations.evidence_refs.dcs_projection_sha256 }
        : {}),
      ...(declarations.evidence_refs?.curve_evidence_sha256 !== undefined
        ? { curve_evidence_sha256: declarations.evidence_refs.curve_evidence_sha256 }
        : {}),
    },
    statement_map: {
      income_statement: proposeSection(caseEvidence, "income_statement", usedRowIds),
      cash_flow: proposeSection(caseEvidence, "cash_flow", usedRowIds),
      ...(declarations.statement_map?.structural_rows
        ? { structural_rows: clone(declarations.statement_map.structural_rows) }
        : {}),
    },
    ...(declarations.derived_rows ? { derived_rows: clone(declarations.derived_rows) } : {}),
    consumption: clone(declarations.consumption ?? {}),
    policies: clone(declarations.policies ?? {}),
    answers: clone(declarations.answers ?? []),
  };
}

export default { proposeCaseSource };
