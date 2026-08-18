import { classifyStatementLine } from "./statement_classifier.mjs";
import { faceStatementManifestDigest } from "./face_statement_manifest.mjs";
import { matchEntities } from "./flow_entity.mjs";

const SECTIONS = Object.freeze(["income_statement", "cash_flow"]);

const CORE_ROLE_ALIASES = Object.freeze({
  income_statement: Object.freeze({
    revenue: ["revenue", "revenues", "turnover", "net sales", "total net sales", "total revenue"],
    gross_profit: ["gross profit"],
    ebit: ["ebit", "earnings before interest and tax", "earnings before interest and taxes"],
    operating_profit: ["operating profit", "operating income"],
    adjusted_ebit: [
      "adjusted ebit",
      "core ebit",
      "underlying ebit",
      "core operating profit",
      "adjusted operating profit",
      "underlying operating profit",
    ],
    reported_ebitda: ["ebitda", "reported ebitda"],
    adjusted_ebitda: ["adjusted ebitda", "core ebitda", "underlying ebitda"],
    depreciation_and_amortisation: [
      "depreciation and amortisation",
      "depreciation and amortization",
    ],
    depreciation_amortisation_and_impairment: [
      "depreciation amortisation and impairment",
      "depreciation amortization and impairment",
      "depreciation and amortisation and impairment",
      "depreciation and amortization and impairment",
    ],
    impairment_loss: ["impairment loss", "impairment charge", "goodwill impairment"],
    interest_income: ["finance income", "interest income"],
    interest_expense: ["finance expense", "interest expense", "finance costs"],
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
    owners_of_parent: [
      "owners of the parent",
      "equity holders of the parent",
      "shareholders of the parent",
      "attributable to owners of the parent",
      "attributable to equity holders of the parent",
    ],
    non_controlling_interests: [
      "non controlling interests",
      "non-controlling interests",
      "attributable to non controlling interests",
      "attributable to non-controlling interests",
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
      "net cash inflow from operating activities",
      "net cash outflow from operating activities",
      "net cash provided by operating activities",
      "cash flow from operating activities",
    ],
    cash_generated_from_operations: ["cash generated from operations"],
    cash_from_investing: [
      "net cash from investing activities",
      "net cash inflow from investing activities",
      "net cash outflow from investing activities",
      "net cash used in investing activities",
      "cash flow from investing activities",
    ],
    cash_from_financing: [
      "net cash from financing activities",
      "net cash inflow from financing activities",
      "net cash outflow from financing activities",
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
      "net increase decrease in cash and cash equivalents in the period",
    ],
    opening_cash: [
      "cash and cash equivalents at beginning of year",
      "cash and cash equivalents at beginning of period",
      "cash and cash equivalents at the beginning of the period",
      "cash and cash equivalents at start of year",
      "cash cash equivalents and restricted cash and cash equivalents beginning balances",
    ],
    ending_cash: [
      "cash and cash equivalents at end of year",
      "cash and cash equivalents at end of period",
      "cash and cash equivalents at the end of the period",
      "cash and cash equivalents at year end",
      "cash cash equivalents and restricted cash and cash equivalents ending balances",
      "ending cash",
    ],
    cash_flow_da: [
      "depreciation and amortisation",
      "depreciation and amortization",
    ],
    cash_flow_da_and_impairment: [
      "depreciation amortisation and impairment",
      "depreciation amortization and impairment",
      "depreciation and amortisation and impairment",
      "depreciation and amortization and impairment",
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
      "repayment of obligations under leases",
    ],
    capex: [
      "capital expenditure",
      "capital expenditures",
    ],
    dividends: ["dividends paid", "dividend paid"],
    debt_issuance: [
      "issue of loans and borrowings",
      "proceeds from loans and borrowings",
      "proceeds from issue of debt",
      "debt issuance",
    ],
    debt_repayment: [
      "repayment of loans and borrowings",
      "repayments of loans and borrowings",
      "repayment of debt",
      "debt repayment",
    ],
    fx_effect_on_cash: [
      "exchange rate effects",
      "effect of exchange rate changes on cash",
      "effect of exchange rate changes on cash and cash equivalents",
      "effects of exchange rate changes on cash and cash equivalents",
      "effect of foreign exchange on cash",
      "exchange differences on cash",
    ],
    share_buybacks: [
      "purchase of own shares",
      "purchases of own shares",
      "repurchase of shares",
      "share repurchases",
    ],
  }),
});

// Canonical structural ids are narrower than semantic roles. They let the
// compiler recognise issuer-specific members of a required aggregate without
// pretending that an individual member (for example PP&E purchases) is the
// aggregate itself (total capex). Matching is exact after punctuation and
// whitespace normalisation, so unfamiliar rows remain visible as filed.
const CANONICAL_ROW_ID_ALIASES = Object.freeze({
  cash_flow: Object.freeze({
    receivables_movement: [
      "increase in trade and other receivables",
      "decrease in trade and other receivables",
      "movement in trade and other receivables",
      "increase in receivables",
      "decrease in receivables",
    ],
    inventory_movement: [
      "increase in inventories",
      "decrease in inventories",
      "movement in inventories",
    ],
    payables_provisions_movement: [
      "increase in trade and other payables and provisions",
      "decrease in trade and other payables and provisions",
      "movement in trade and other payables and provisions",
    ],
    ppe_purchases: [
      "purchase of property plant and equipment",
      "purchases of property plant and equipment",
      "additions to property plant and equipment",
    ],
    intangible_purchases: [
      "purchase of intangible assets",
      "purchases of intangible assets",
      "additions to intangible assets",
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

function canonicalRowId(section, label) {
  const target = normalise(label);
  for (const [rowId, aliases] of Object.entries(CANONICAL_ROW_ID_ALIASES[section] ?? {})) {
    if (aliases.some((alias) => normalise(alias) === target)) return rowId;
  }
  return null;
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
  if (section === "cash_flow" && role === "depreciation_and_amortisation") {
    return "cash_flow_da";
  }
  if (
    section === "cash_flow" &&
    role === "depreciation_amortisation_and_impairment"
  ) {
    return "cash_flow_da_and_impairment";
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

function hasPositiveHeaderEvidence(row) {
  return row?.structural_role === "header" || row?.row_type === "header";
}

function proposeSection(caseEvidence, section, used) {
  const lines = manifestRows(caseEvidence, section);
  const rowIdBySource = new Map();
  const roleBySource = new Map();
  const brokerMetrics = new Set(
    Object.keys(caseEvidence?.lanes?.broker_pack?.metrics ?? {}),
  );

  for (const { row } of lines) {
    const numericType = /(?:margin|rate|percent|percentage)\s*%?$/i.test(row.raw_label ?? "")
      ? "percentage"
      : (row.values ?? []).some(
          (value) => value !== null && value !== "" && Number.isFinite(Number(value)),
        )
        ? "currency"
        : null;
    const lineIndex = lines.findIndex((entry) => entry.row === row);
    const neighbouringLabels = lines
      .slice(Math.max(0, lineIndex - 1), lineIndex + 2)
      .filter((entry) => entry.row !== row)
      .map((entry) => entry.row.raw_label)
      .filter(Boolean);
    const parentLabel = row.parent_source_line_id
      ? lines.find((entry) => entry.row.source_line_id === row.parent_source_line_id)?.row.raw_label
      : null;
    const classification = classifyStatementLine({
      label: row.raw_label,
      section,
      parent_label: parentLabel,
      neighbouring_labels: neighbouringLabels,
      numeric_type: numericType,
      is_subtotal: row.is_subtotal === true,
    });
    const classifiedRole = classification.status === "accepted"
      ? classification.classified_role
      : null;
    // Exact aliases are discovery vocabulary only. The independent classifier
    // must accept the source label in its statement, numeric and structural
    // context before the proposer may write an economic role.
    const role = contextualRole(
      section,
      row,
      classifiedRole,
    );
    roleBySource.set(row.source_line_id, role);
    rowIdBySource.set(
      row.source_line_id,
      sanitizeRowId(
        canonicalRowId(section, row.raw_label) ?? role ?? row.raw_label ?? row.source_line_id,
        used,
      ),
    );
  }

  // A filed operating-profit line is the model's EBIT authority when the
  // issuer prints no distinct EBIT line. If both are printed, preserve both
  // semantic nodes; collapsing them creates duplicate visible authority and
  // destroys the reported reconciliation surface.
  if (
    section === "income_statement" &&
    ![...roleBySource.values()].includes("ebit")
  ) {
    const operatingProfit = [...roleBySource.entries()].find(
      ([, role]) => role === "operating_profit",
    );
    if (operatingProfit) roleBySource.set(operatingProfit[0], "ebit");
  }
  if (
    section === "cash_flow" &&
    ![...roleBySource.values()].includes("cash_flow_net_income")
  ) {
    const preTaxRoot = [...roleBySource.entries()].find(
      ([, role]) => role === "cash_flow_profit_before_tax",
    );
    if (preTaxRoot) {
      roleBySource.set(preTaxRoot[0], "cash_flow_net_income");
      const previousRowId = rowIdBySource.get(preTaxRoot[0]);
      if (previousRowId) used.delete(previousRowId);
      rowIdBySource.set(
        preTaxRoot[0],
        sanitizeRowId("cash_flow_net_income", used),
      );
    }
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
      ...(hasPositiveHeaderEvidence(row) ? { header: true } : {}),
    };
    return entry;
  });
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function evidenceBoundPolicies(declarations, caseEvidence) {
  const policies = clone(declarations.policies ?? {});
  const rcf = caseEvidence?.lanes?.policy_evidence?.rcf;
  const rcfAuthorities = new Map(
    (caseEvidence?.lanes?.instrument_term_authorities ?? [])
      .filter((authority) => authority.instrument_id === rcf?.instrument_id)
      .map((authority) => [authority.model_field, authority.output_value]),
  );
  // A field-level DCS authority is evidence, not a user-selectable modelling
  // convention. A stale declaration from a template or resumed older runtime
  // may not overwrite the raw export's exact contractual fee convention.
  if (rcfAuthorities.has("commitment_fee_convention")) {
    policies.rcf ??= {};
    delete policies.rcf.commitment_fee_convention;
  }
  return policies;
}

/**
 * Compile the declarations-only case-source surface from the immutable filing
 * manifests. Every filed line is retained exactly once. High-confidence roles
 * are declared; unfamiliar issuer-specific lines remain visible under their
 * exact filed label and proceed to the forecast authority graph.
 */
export function proposeCaseSource({
  declarations = {},
  caseEvidence,
  evidenceRunSha256 = null,
  filings = null,
}) {
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
  const declaredIdentity = clone(declarations.identity);
  let identity = declaredIdentity;
  if (filings?.entity_name) {
    const filingIdentity = {
      name: filings.entity_name,
      identifiers: filings.entity_identifiers ?? {},
      aliases: filings.entity_aliases ?? [],
      consolidation_level: filings.consolidation_level ?? null,
    };
    const declaredDescriptor = {
      name: declaredIdentity.issuer_name,
      identifiers: declaredIdentity.identifiers ?? {},
      aliases: declaredIdentity.aliases ?? [],
      consolidation_level: declaredIdentity.consolidation_level ?? null,
    };
    const match = matchEntities(declaredDescriptor, filingIdentity);
    if (["mismatch", "ambiguous"].includes(match.verdict)) {
      throw new Error(
        `Case-source identity conflicts with the sealed filings identity: ${match.kind ?? match.verdict}.`,
      );
    }
    identity = {
      ...declaredIdentity,
      issuer_name: filings.entity_name,
      reporting_currency: filings.reporting_currency ?? declaredIdentity.reporting_currency,
      ...(Object.keys(filings.entity_identifiers ?? {}).length > 0
        ? { identifiers: clone(filings.entity_identifiers) }
        : {}),
      ...((filings.entity_aliases ?? []).length > 0
        ? { aliases: [...new Set([...(declaredIdentity.aliases ?? []), ...filings.entity_aliases])] }
        : {}),
      ...(filings.consolidation_level
        ? { consolidation_level: filings.consolidation_level }
        : {}),
      ...(filings.accounting_framework
        ? { accounting_framework: filings.accounting_framework }
        : {}),
    };
  }
  return {
    schema_version: "case-source-v1",
    identity,
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
    policies: evidenceBoundPolicies(declarations, caseEvidence),
    answers: clone(declarations.answers ?? []),
  };
}

function firstMappedHistoricalSeries({ caseSource, caseEvidence, roles, absolute = false }) {
  const roleSet = new Set(roles);
  for (const section of SECTIONS) {
    const mappings = new Map(
      (caseSource?.statement_map?.[section] ?? [])
        .filter((entry) => roleSet.has(entry?.role) || roleSet.has(entry?.row_id))
        .map((entry) => [entry.source_line_id, entry]),
    );
    for (const { row } of manifestRows(caseEvidence, section)) {
      if (!mappings.has(row.source_line_id)) continue;
      const values = (row.values ?? []).slice(0, 3).map((value) =>
        value === null || value === "" || !Number.isFinite(Number(value))
          ? null
          : absolute ? Math.abs(Number(value)) : Number(value),
      );
      if (values.some((value) => value !== null)) return values;
    }
  }
  return [null, null, null];
}

function firstMappedHistoricalRecord({ caseSource, caseEvidence, roles }) {
  const roleSet = new Set(roles);
  for (const section of SECTIONS) {
    const mapped = new Set(
      (caseSource?.statement_map?.[section] ?? [])
        .filter((entry) => roleSet.has(entry?.role) || roleSet.has(entry?.row_id))
        .map((entry) => entry.source_line_id),
    );
    for (const { manifest, row } of manifestRows(caseEvidence, section)) {
      if (mapped.has(row.source_line_id)) return { manifest, row };
    }
  }
  return null;
}

function addSeries(left, right) {
  return [0, 1, 2].map((index) =>
    left?.[index] !== null && left?.[index] !== undefined &&
      right?.[index] !== null && right?.[index] !== undefined &&
      Number.isFinite(Number(left[index])) && Number.isFinite(Number(right[index]))
      ? Number(left[index]) + Number(right[index])
      : null,
  );
}

function runtimeMetric(values, note) {
  return {
    values: [...values.slice(0, 3), null, null, null],
    forecast_method: "derived_compatible",
    source_kind: "company_reported",
    note,
  };
}

/**
 * Project the minimum production evidence lanes from sealed upstream evidence.
 *
 * A first-run host is allowed to declare identity, policy choices and answers;
 * it is not allowed to smuggle in a model-ready operating case.  This writer
 * therefore derives statement-backed history, periods, cash and reconciliation
 * lanes after the filing manifests and DCS projection have been validated.  It
 * only fills absent runtime-owned lanes, preserving any independently sealed
 * richer evidence already present on a rebuild.
 */
export function writeRuntimeEvidenceLanes({ evidence, caseSource }) {
  if (!evidence?.case_evidence?.face_statement_manifests) {
    throw new Error("Runtime evidence writing requires sealed face-statement manifests.");
  }
  const filings = evidence.filings ?? {};
  const caseEvidence = evidence.case_evidence;
  const lanes = caseEvidence.lanes ??= {};
  const historicalPeriods = filings.historical_periods ?? [];
  const forecastPeriods = filings.forecast_periods ?? [];
  if (historicalPeriods.length !== 3 || forecastPeriods.length !== 3) {
    throw new Error("Runtime evidence writing requires exactly three historical and three forecast periods.");
  }

  lanes.periods ??= [
    ...historicalPeriods.map((date) => ({ date, status: "historical" })),
    ...forecastPeriods.map((date) => ({ date, status: "forecast" })),
  ];
  lanes.modules ??= {
    multi_currency: false,
    historical_normalisation: false,
    acquisition: false,
  };
  lanes.controls = {
    broker_case: "Forecast Waterfall",
    circularity: 1,
    debt_maturities_roll: 1,
    ...(lanes.controls ?? {}),
  };
  lanes.source_coverage_review ??= {
    status: "complete",
    reviewed_at: historicalPeriods.at(-1),
    review_evidence:
      "Compiler-owned coverage review of the complete sealed income-statement and cash-flow face-statement manifests.",
  };

  const revenue = firstMappedHistoricalSeries({
    caseSource, caseEvidence, roles: ["revenue"],
  });
  const ebit = firstMappedHistoricalSeries({
    caseSource, caseEvidence, roles: ["ebit", "operating_profit"],
  });
  const adjustedEbit = firstMappedHistoricalSeries({
    caseSource, caseEvidence, roles: ["adjusted_ebit"],
  });
  const reportedAdjustedEbitda = firstMappedHistoricalSeries({
    caseSource, caseEvidence, roles: ["adjusted_ebitda"],
  });
  const reportedEbitda = firstMappedHistoricalSeries({
    caseSource, caseEvidence, roles: ["reported_ebitda"],
  });
  const da = firstMappedHistoricalSeries({
    caseSource,
    caseEvidence,
    roles: ["depreciation_and_amortisation", "cash_flow_da", "is_da_expense"],
    absolute: true,
  });
  const complete = (series) => series.every(
    (value) => value !== null && Number.isFinite(Number(value)),
  );
  let selectedEbitda;
  let selectedEbitdaBasis;
  if (complete(reportedAdjustedEbitda)) {
    selectedEbitda = reportedAdjustedEbitda;
    selectedEbitdaBasis = {
      semantic_role: "adjusted_ebitda",
      label: "Adjusted EBITDA",
      derivation: "company_reported",
      source_roles: ["adjusted_ebitda"],
    };
  } else if (complete(reportedEbitda)) {
    selectedEbitda = reportedEbitda;
    selectedEbitdaBasis = {
      semantic_role: "reported_ebitda",
      label: "EBITDA",
      derivation: "company_reported",
      source_roles: ["reported_ebitda"],
    };
  } else if (complete(adjustedEbit) && complete(da)) {
    selectedEbitda = addSeries(adjustedEbit, da);
    selectedEbitdaBasis = {
      semantic_role: "adjusted_ebitda",
      label: "Adjusted EBITDA",
      derivation: "company_adjusted_ebit_plus_compatible_da",
      source_roles: ["adjusted_ebit", "depreciation_and_amortisation"],
    };
  } else if (complete(ebit) && complete(da)) {
    selectedEbitda = addSeries(ebit, da);
    selectedEbitdaBasis = {
      semantic_role: "reported_ebitda",
      label: "EBITDA",
      derivation: "reported_ebit_plus_compatible_da",
      source_roles: ["ebit", "depreciation_and_amortisation"],
    };
  } else {
    selectedEbitda = [null, null, null];
    selectedEbitdaBasis = null;
  }
  const workingCapital = firstMappedHistoricalSeries({
    caseSource, caseEvidence, roles: ["change_in_working_capital"],
  });
  const capex = firstMappedHistoricalSeries({
    caseSource,
    caseEvidence,
    roles: ["capex", "ppe_purchases", "intangible_purchases"],
    absolute: true,
  });
  const tax = firstMappedHistoricalSeries({
    caseSource, caseEvidence, roles: ["tax_expense", "cash_taxes"], absolute: true,
  });
  lanes.operating_metrics ??= {
    revenue: runtimeMetric(revenue, "Historical values projected from the sealed filed revenue authority; forecasts are written by the authority resolver."),
    // `adjusted_ebitda` is retained as the v2 transport key.  Its economic
    // definition is not inferred from that legacy key; the sealed selected
    // basis below controls the statement label and every denominator.
    adjusted_ebitda: runtimeMetric(selectedEbitda, "Historical values use the sealed selected EBITDA basis; forecasts are written by the authority resolver."),
    depreciation_and_amortisation: runtimeMetric(da, "Historical D&A projected from the sealed filed statement authority; forecasts are written by the authority resolver."),
    change_in_working_capital: runtimeMetric(workingCapital, "Historical working-capital movement projected from the sealed cash-flow authority; forecasts are written by the authority resolver."),
    capex: runtimeMetric(capex, "Historical capex projected on the model outflow basis from the sealed cash-flow authority; forecasts are written by the authority resolver."),
    tax: runtimeMetric(tax, "Historical tax projected on the model expense basis from the sealed statement authority; forecasts are written by the authority resolver."),
  };
  if (selectedEbitdaBasis) {
    lanes.selected_ebitda_basis ??= {
      ...selectedEbitdaBasis,
      transport_metric_id: "adjusted_ebitda",
      impairment_included: false,
    };
  }
  lanes.provenance ??= {};
  const sourceInventory = new Map(
    (evidence.source_inventory ?? []).map((source) => [source.source_id, source]),
  );
  const provenanceRoles = {
    revenue: ["revenue"],
    adjusted_ebitda: selectedEbitdaBasis?.source_roles ?? [],
    depreciation_and_amortisation: [
      "depreciation_and_amortisation", "cash_flow_da", "is_da_expense",
    ],
    change_in_working_capital: ["change_in_working_capital"],
    capex: ["capex", "ppe_purchases", "intangible_purchases"],
    tax: ["tax_expense", "cash_taxes"],
  };
  for (const [metricId, roles] of Object.entries(provenanceRoles)) {
    if (lanes.provenance[metricId]) continue;
    const record = firstMappedHistoricalRecord({ caseSource, caseEvidence, roles });
    if (!record) continue;
    const source = sourceInventory.get(record.manifest.source_id) ?? {};
    lanes.provenance[metricId] = [0, 1, 2].map((periodIndex) => ({
      period_index: periodIndex,
      document: record.manifest.source_id,
      publication_date: source.publication_date ?? "not supplied in filing metadata",
      page_or_note: record.row.page_or_note ?? record.manifest.page_or_note,
      units: [caseSource.identity.reporting_currency, caseSource.identity.units]
        .filter(Boolean).join(" "),
      source_label: record.row.raw_label,
      transformation: metricId === "adjusted_ebitda" && selectedEbitdaBasis?.derivation !== "company_reported"
        ? `Compiler-owned ${selectedEbitdaBasis?.label ?? "EBITDA"} bridge from sealed filed authorities (${selectedEbitdaBasis?.derivation ?? "unsupported"}).`
        : "Directly projected from the sealed face-statement authority.",
    }));
  }

  const endingCash = firstMappedHistoricalSeries({
    caseSource, caseEvidence, roles: ["ending_cash"], absolute: true,
  });
  if (!endingCash.every((value) => value !== null && Number.isFinite(Number(value)))) {
    throw new Error(
      "The sealed cash-flow statement does not establish all three historical ending-cash balances required by the model.",
    );
  }
  lanes.policy_evidence ??= {};
  lanes.policy_evidence.cash ??= {
    opening_cash: Number(endingCash[2]),
    historical_year_end_cash: endingCash.map(Number),
  };
  lanes.policy_evidence.lease ??= {
    opening_liability: Number(filings.reported_lease_liability ?? 0),
  };

  const historicalGrossDebt = Array.isArray(filings.historical_gross_debt) &&
      filings.historical_gross_debt.length === 3 &&
      filings.historical_gross_debt.every((value) => Number.isFinite(Number(value)))
    ? filings.historical_gross_debt.map(Number)
    : null;
  lanes.debt_reconciliation ??= {
    reported_opening_gross_debt: historicalGrossDebt ?? Number(filings.reported_gross_debt ?? 0),
    maximum_residual_percentage: Number(filings.maximum_residual_percentage ?? 0.05),
    note: "Compiler-owned projection of the filed opening gross-debt authority.",
  };
  const filedInterest = firstMappedHistoricalSeries({
    caseSource, caseEvidence, roles: ["interest_expense"], absolute: true,
  });
  if (filedInterest.every((value) => value !== null && Number.isFinite(Number(value)))) {
    lanes.historical_interest_reconciliation ??= {
      reported_interest_basis: "identified_components_only",
      identified_interest: filedInterest.map(Number),
      maximum_plug_percentage: 0.1,
    };
  }
  lanes.historical_supplement ??= {
    prior_cash_and_cash_equivalents: endingCash.slice(0, 2).map(Number),
    ...(historicalGrossDebt
      ? { prior_gross_debt_excluding_leases: historicalGrossDebt.slice(0, 2) }
      : {}),
  };
  // The current model contract requires an explicit three-period residual
  // interest series. A first-run with no sealed residual authority has zero
  // residual interest; richer upstream evidence remains authoritative.
  lanes.other_interest ??= [0, 0, 0];
  lanes.broker_pack ??= evidence.broker_pack ?? {
    source_label: "Forecast Waterfall — zero broker authority",
    forecast_periods: forecastPeriods,
    metrics: {},
  };
  return evidence;
}

export default { proposeCaseSource, writeRuntimeEvidenceLanes };
