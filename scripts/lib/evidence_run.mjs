import fs from "node:fs";

import { assessCoverage } from "./coverage.mjs";
import { matchEntities } from "./flow_entity.mjs";
import { runIntake } from "./intake.mjs";
import { validateJsonSchema } from "./json_schema.mjs";
import { validateCaseShape } from "./solver.mjs";
import { hashValue } from "./run_store.mjs";
import {
  FACE_STATEMENT_SECTIONS,
  faceStatementManifestDigest,
} from "./face_statement_manifest.mjs";

const EVIDENCE_SCHEMA = JSON.parse(
  fs.readFileSync(
    new URL("../../assets/evidence-run-v1.schema.json", import.meta.url),
    "utf8",
  ),
);

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value);

function finding(id, severity, message, evidence = null) {
  return { id, severity, message, evidence };
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function modelPeriods(modelCase, status) {
  return (modelCase?.periods ?? [])
    .filter((period) => period.status === status)
    .map((period) => period.date);
}

function approximate(left, right, tolerance = 1e-6) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function resolveHistoricalStatementSeries(modelCase, section) {
  const rows = modelCase?.statement_structure?.[section] ?? [];
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const periodCaches = [new Map(), new Map(), new Map()];

  const resolve = (rowId, periodIndex, visiting = new Set()) => {
    const cache = periodCaches[periodIndex];
    if (cache.has(rowId)) return cache.get(rowId);
    const row = byId.get(rowId);
    if (!row || visiting.has(rowId)) return null;

    const stated = row.values?.[periodIndex];
    if (finite(stated)) {
      cache.set(rowId, Number(stated));
      return Number(stated);
    }

    const calculation = row.calculation;
    if (!calculation || !Array.isArray(calculation.refs)) return null;
    if (calculation.refs.length === 0) return null;

    const nextVisiting = new Set(visiting);
    nextVisiting.add(rowId);
    const current = calculation.refs.map((ref) =>
      resolve(ref, periodIndex, nextVisiting),
    );
    if (current.some((value) => value === null)) return null;
    const previous = (ref) =>
      periodIndex === 0 ? null : resolve(ref, periodIndex - 1, new Set());

    let value = null;
    switch (calculation.operator) {
      case "sum":
        value = current.reduce((sum, item) => sum + item, 0);
        break;
      case "link":
        value = current[0];
        break;
      case "subtract":
        value = current.slice(1).reduce(
          (result, item) => result - item,
          current[0],
        );
        break;
      case "negate":
        value = -current[0];
        break;
      case "negate_sum":
        value = -current.reduce((sum, item) => sum + item, 0);
        break;
      case "ratio":
        value = current[1] === 0 ? 0 : current[0] / current[1];
        break;
      case "negated_ratio":
        value = current[1] === 0 ? 0 : -current[0] / current[1];
        break;
      case "growth": {
        const prior = previous(calculation.refs[0]);
        value = prior === null || prior === 0 ? null : current[0] / prior - 1;
        break;
      }
      case "tax":
        value = current[0] > 0 ? -current[0] * current[1] : 0;
        break;
      case "average":
        value = current.reduce((sum, item) => sum + item, 0) / current.length;
        break;
      case "prior_period":
        value = previous(calculation.refs[0]);
        break;
      case "prior_period_scaled_by": {
        const priorValue = previous(calculation.refs[0]);
        const priorDriver = previous(calculation.refs[1]);
        value =
          priorValue === null || priorDriver === null || priorDriver === 0
            ? null
            : (priorValue * current[1]) / priorDriver;
        break;
      }
      default:
        value = null;
    }
    if (finite(value)) cache.set(rowId, Number(value));
    return finite(value) ? Number(value) : null;
  };

  return new Map(
    rows.map((row) => [
      row.row_id,
      [0, 1, 2].map((periodIndex) =>
        resolve(row.row_id, periodIndex, new Set()),
      ),
    ]),
  );
}

function seriesMatches(left, right, comparable, tolerance = 1e-6) {
  return comparable.every(
    (periodIndex) =>
      finite(left?.[periodIndex]) &&
      finite(right?.[periodIndex]) &&
      approximate(left[periodIndex], right[periodIndex], tolerance),
  );
}

function bridgeMetricSourceIds(bridge) {
  const ids = new Set();
  for (const metric of bridge?.metrics ?? []) {
    for (const sourceId of metric.reported_source_ids ?? []) ids.add(sourceId);
    for (const adjustment of metric.adjustments ?? []) {
      for (const sourceId of adjustment.source_ids ?? []) ids.add(sourceId);
    }
  }
  return [...ids].sort();
}

/**
 * Content digest for an advanced-history numeric bridge. The digest binds the
 * period, selected basis, every numeric bridge term and the content hash of
 * every source named by the basis decision. Callers may use this helper when
 * compiling an evidence-run envelope; validation recomputes it independently.
 */
export function historicalBridgeDigest(run, decision) {
  const inventory = new Map(
    (run?.source_inventory ?? []).map((source) => [source.source_id, source]),
  );
  const sourceBindings = [...new Set(decision?.source_ids ?? [])]
    .sort()
    .map((sourceId) => ({
      source_id: sourceId,
      content_sha256: inventory.get(sourceId)?.content_sha256 ?? null,
    }));
  return hashValue({
    schema_version:
      decision?.numeric_bridge?.schema_version ??
      "historical-numeric-bridge/1.0",
    period: decision?.period ?? null,
    basis: decision?.basis ?? null,
    source_bindings: sourceBindings,
    metrics: decision?.numeric_bridge?.metrics ?? [],
  });
}

function canonicalHistoricalValue(modelCase, canonicalPath, metricId, periodIndex) {
  const operatingPrefix = "operating_metrics.";
  if (canonicalPath?.startsWith(operatingPrefix)) {
    const pathMetricId = canonicalPath.slice(operatingPrefix.length);
    if (pathMetricId !== metricId) {
      return { error: `canonical_path resolves ${pathMetricId}, not metric_id ${metricId}.` };
    }
    const metric = modelCase?.operating_metrics?.[pathMetricId];
    if (!metric) return { error: `Canonical operating metric ${pathMetricId} is absent.` };
    const value = metric.values?.[periodIndex];
    return finite(value)
      ? { value: Number(value) }
      : { error: `Canonical operating metric ${pathMetricId} has no numeric value for historical period ${periodIndex + 1}.` };
  }

  const statementPrefix = "statement_structure.";
  if (canonicalPath?.startsWith(statementPrefix)) {
    const remainder = canonicalPath.slice(statementPrefix.length);
    const separator = remainder.indexOf(".");
    const section = remainder.slice(0, separator);
    const rowId = remainder.slice(separator + 1);
    if (!["income_statement", "cash_flow"].includes(section) || !rowId) {
      return { error: `Canonical statement path ${canonicalPath} is invalid.` };
    }
    if (rowId !== metricId) {
      return { error: `canonical_path resolves ${rowId}, not metric_id ${metricId}.` };
    }
    const rows = modelCase?.statement_structure?.[section] ?? [];
    const matches = rows.filter((row) => row.row_id === rowId);
    if (matches.length !== 1) {
      return { error: `Canonical statement row ${section}.${rowId} resolves ${matches.length} times.` };
    }
    const value = matches[0].values?.[periodIndex];
    return finite(value)
      ? { value: Number(value) }
      : { error: `Canonical statement row ${section}.${rowId} has no numeric value for historical period ${periodIndex + 1}.` };
  }

  return { error: `Canonical path ${canonicalPath ?? "<missing>"} is unsupported.` };
}

function hasSupplement(run, instrumentId, field) {
  return (run?.decisions?.manual_debt_supplements ?? []).some(
    (entry) => entry.instrument_id === instrumentId && entry.field === field,
  );
}

function compareEntity(findings, id, left, right) {
  const result = matchEntities(left, right);
  if (result.verdict !== "match") {
    findings.push(
      finding(
        id,
        "BLOCK",
        `Entity identity is ${result.verdict}: ${JSON.stringify(left)} versus ${JSON.stringify(right)}.`,
        result,
      ),
    );
  }
}

function validateSourceInventory(run, findings) {
  const inventory = run.source_inventory ?? [];
  const ids = new Set();
  for (const source of inventory) {
    if (ids.has(source.source_id)) {
      findings.push(
        finding(
          "evidence.source.duplicate",
          "BLOCK",
          `Source id ${source.source_id} appears more than once.`,
        ),
      );
    }
    ids.add(source.source_id);
    if (source.status === "used" && source.text_extractable === false) {
      findings.push(
        finding(
          "evidence.source.not_extractable",
          "BLOCK",
          `Used source ${source.source_id} has no extractable text.`,
        ),
      );
    }
  }

  const used = inventory.filter((source) => source.status === "used");
  const count = (kind) => used.filter((source) => source.kind === kind).length;
  if (count("user_factset_export") !== 1) {
    findings.push(
      finding(
        "evidence.source.factset_count",
        "BLOCK",
        `Exactly one used FactSet export is required; found ${count("user_factset_export")}.`,
      ),
    );
  }
  const brokerCount = count("user_broker_research");
  if (brokerCount < 3 || brokerCount > 10) {
    findings.push(
      finding(
        "evidence.source.broker_count",
        "BLOCK",
        `Used broker research sources must be between 3 and 10; found ${brokerCount}.`,
      ),
    );
  }
  const filingCount = used.filter((source) =>
    ["company_annual_report", "company_interim_update"].includes(source.kind),
  ).length;
  if (filingCount === 0) {
    findings.push(
      finding(
        "evidence.source.filings_absent",
        "BLOCK",
        "At least one used company annual or interim filing is required.",
      ),
    );
  }
  if (run.mode === "rebuild") {
    if (!run.prior_case_receipt || count("prior_case") !== 1) {
      findings.push(
        finding(
          "evidence.rebuild.prior_case_absent",
          "BLOCK",
          "Rebuild mode requires one prior-case source and its content-hash receipt.",
        ),
      );
    }
  } else if (run.prior_case_receipt) {
    findings.push(
      finding(
        "evidence.rebuild.unexpected_prior_case",
        "BLOCK",
        "A prior-case receipt is present but mode is first_run.",
      ),
    );
  }

  for (const decision of run.retrieval_log ?? []) {
    const source = inventory.find(
      (entry) => entry.source_id === decision.selected_source_id,
    );
    if (!source) {
      findings.push(
        finding(
          "evidence.retrieval.missing_source",
          "BLOCK",
          `Retrieval decision ${decision.fact_id} points to absent source ${decision.selected_source_id}.`,
        ),
      );
    } else if (source.status !== "used") {
      findings.push(
        finding(
          "evidence.retrieval.source_not_used",
          "BLOCK",
          `Retrieval decision ${decision.fact_id} selects source ${decision.selected_source_id}, whose status is ${source.status}.`,
        ),
      );
    }
    for (const superseded of decision.supersedes_source_ids ?? []) {
      if (!ids.has(superseded)) {
        findings.push(
          finding(
            "evidence.retrieval.superseded_source_absent",
            "BLOCK",
            `Retrieval decision ${decision.fact_id} supersedes unknown source ${superseded}.`,
          ),
        );
      }
    }
  }
  return ids;
}

function validateAttachmentIngress(run, findings) {
  const ingress = run.ingress;
  const manifest = run.attachment_manifest;
  // Legacy fixture/evidence files intentionally remain readable. A production
  // ingress run, however, is all-or-nothing: it must carry the compiler marker
  // and a self-consistent byte manifest.
  if (ingress === undefined && manifest === undefined) return;
  if (!ingress || !Array.isArray(manifest)) {
    findings.push(finding("evidence.ingress.incomplete", "BLOCK", "Attachment ingress requires both ingress metadata and attachment_manifest."));
    return;
  }
  if (ingress.manifest_sha256 !== hashValue(manifest)) {
    findings.push(finding("evidence.ingress.manifest_hash_mismatch", "BLOCK", "Attachment manifest hash does not match the manifest bytes."));
  }
  const byAttachment = new Map();
  const sourceToAttachment = new Map();
  for (const entry of manifest) {
    if (byAttachment.has(entry.attachment_id)) {
      findings.push(finding("evidence.ingress.duplicate_attachment", "BLOCK", `Attachment ${entry.attachment_id} appears more than once.`));
    }
    byAttachment.set(entry.attachment_id, entry);
    for (const sourceId of entry.source_ids ?? []) {
      if (sourceToAttachment.has(sourceId)) {
        findings.push(finding("evidence.ingress.source_bound_twice", "BLOCK", `Source ${sourceId} is bound to more than one raw attachment.`));
      }
      sourceToAttachment.set(sourceId, entry);
    }
  }
  for (const source of run.source_inventory ?? []) {
    const attachment = sourceToAttachment.get(source.source_id);
    if (!attachment) {
      findings.push(finding("evidence.ingress.source_unbound", "BLOCK", `Inventoried source ${source.source_id} has no raw attachment binding.`));
      continue;
    }
    if (source.attachment_id !== attachment.attachment_id) {
      findings.push(finding("evidence.ingress.source_attachment_mismatch", "BLOCK", `Source ${source.source_id} does not name its manifest attachment.`));
    }
    if (source.content_sha256 !== attachment.raw_sha256) {
      findings.push(finding("evidence.ingress.source_hash_mismatch", "BLOCK", `Source ${source.source_id} hash does not equal its attached raw bytes.`));
    }
  }
}

const normalizedStatementLabel = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function validateFaceStatementManifests(run, findings) {
  const inventory = new Map(
    (run.source_inventory ?? []).map((source) => [source.source_id, source]),
  );
  const historicalPeriods = run.filings?.historical_periods ?? [];
  const rowsBySection = Object.fromEntries(
    FACE_STATEMENT_SECTIONS.map((section) => [section, []]),
  );

  for (const section of FACE_STATEMENT_SECTIONS) {
    const manifests = run.filings?.face_statement_manifests?.[section] ?? [];
    if (manifests.length === 0) {
      findings.push(
        finding(
          "evidence.statement.manifest_missing",
          "BLOCK",
          `${section} has no independent face-statement manifest.`,
        ),
      );
      continue;
    }

    const seenLineIds = new Set();
    for (const [manifestIndex, manifest] of manifests.entries()) {
      if (manifest.statement !== section) {
        findings.push(
          finding(
            "evidence.statement.manifest_wrong_statement",
            "BLOCK",
            `${section} manifest ${manifestIndex + 1} declares ${manifest.statement ?? "no statement"}.`,
          ),
        );
      }
      if (manifest.statement_order !== manifestIndex + 1) {
        findings.push(
          finding(
            "evidence.statement.manifest_order_invalid",
            "BLOCK",
            `${section} manifest order must be contiguous from 1; position ${manifestIndex + 1} declares ${manifest.statement_order ?? "missing"}.`,
          ),
        );
      }
      if (!sameArray(manifest.periods, historicalPeriods)) {
        findings.push(
          finding(
            "evidence.statement.manifest_period_mismatch",
            "BLOCK",
            `${section} manifest ${manifestIndex + 1} does not use the selected historical periods.`,
          ),
        );
      }
      if (manifest.complete_face_statement !== true) {
        findings.push(
          finding(
            "evidence.statement.manifest_incomplete_attestation",
            "BLOCK",
            `${section} manifest ${manifestIndex + 1} does not attest that the complete face statement was extracted.`,
          ),
        );
      }
      const source = inventory.get(manifest.source_id);
      if (!source) {
        findings.push(
          finding(
            "evidence.statement.manifest_source_absent",
            "BLOCK",
            `${section} manifest ${manifestIndex + 1} cites unknown source ${manifest.source_id}.`,
          ),
        );
      } else {
        if (source.status !== "used") {
          findings.push(
            finding(
              "evidence.statement.manifest_source_not_used",
              "BLOCK",
              `${section} manifest ${manifestIndex + 1} cites ${manifest.source_id}, whose status is ${source.status}.`,
            ),
          );
        }
        if (![
          "company_annual_report",
          "company_interim_update",
        ].includes(source.kind)) {
          findings.push(
            finding(
              "evidence.statement.manifest_source_kind_invalid",
              "BLOCK",
              `${section} manifest ${manifestIndex + 1} cites ${source.kind}, not an annual or interim filing.`,
            ),
          );
        }
        if (manifest.document_sha256 !== source.content_sha256) {
          findings.push(
            finding(
              "evidence.statement.manifest_source_hash_mismatch",
              "BLOCK",
              `${section} manifest ${manifestIndex + 1} is not bound to the selected source bytes.`,
            ),
          );
        }
      }
      if (manifest.row_count !== (manifest.rows ?? []).length) {
        findings.push(
          finding(
            "evidence.statement.manifest_row_count_mismatch",
            "BLOCK",
            `${section} manifest ${manifestIndex + 1} declares ${manifest.row_count ?? "missing"} rows but contains ${(manifest.rows ?? []).length}.`,
          ),
        );
      }
      if (manifest.rows_sha256 !== faceStatementManifestDigest(manifest)) {
        findings.push(
          finding(
            "evidence.statement.manifest_hash_mismatch",
            "BLOCK",
            `${section} manifest ${manifestIndex + 1} digest does not match its ordered rows and source binding.`,
          ),
        );
      }

      const manifestLineIds = new Set(
        (manifest.rows ?? []).map((row) => row.source_line_id),
      );
      for (const [rowIndex, row] of (manifest.rows ?? []).entries()) {
        if (row.ordinal !== rowIndex + 1) {
          findings.push(
            finding(
              "evidence.statement.manifest_ordinal_gap",
              "BLOCK",
              `${section}.${row.source_line_id ?? `row_${rowIndex + 1}`} must have ordinal ${rowIndex + 1}, not ${row.ordinal ?? "missing"}.`,
            ),
          );
        }
        if (seenLineIds.has(row.source_line_id)) {
          findings.push(
            finding(
              "evidence.statement.manifest_duplicate_line",
              "BLOCK",
              `${section}.${row.source_line_id} appears more than once in the selected face-statement manifests.`,
            ),
          );
        }
        seenLineIds.add(row.source_line_id);
        if (
          row.parent_source_line_id &&
          (!manifestLineIds.has(row.parent_source_line_id) ||
            row.parent_source_line_id === row.source_line_id)
        ) {
          findings.push(
            finding(
              "evidence.statement.manifest_parent_invalid",
              "BLOCK",
              `${section}.${row.source_line_id} has an absent or self-referential parent ${row.parent_source_line_id}.`,
            ),
          );
        }
        rowsBySection[section].push({
          manifest,
          row,
          source_id: manifest.source_id,
        });
      }
    }
  }
  return rowsBySection;
}

function validateStatementMapping(run, sourceIds, findings) {
  const modelCase = run.model_case ?? {};
  const manifestRows = validateFaceStatementManifests(run, findings);
  const structuralRows = {};
  for (const section of ["income_statement", "cash_flow"]) {
    const statementRows = modelCase.statement_structure?.[section] ?? [];
    structuralRows[section] = new Set(statementRows.map((row) => row.row_id));
    const rowsById = new Map(statementRows.map((row) => [row.row_id, row]));
    const coverage = modelCase.source_coverage?.[section] ?? [];
    const coverageById = new Map(
      coverage.map((line) => [line.source_line_id, line]),
    );
    const filingLines = run.filings?.[section] ?? [];
    const filingLineIds = new Set(
      filingLines.map((line) => line.source_line_id),
    );
    const manifestEntries = manifestRows[section] ?? [];
    const manifestById = new Map(
      manifestEntries.map((entry) => [entry.row.source_line_id, entry]),
    );
    const manifestOrder = manifestEntries.map(
      (entry) => entry.row.source_line_id,
    );
    const filingOrder = filingLines.map((line) => line.source_line_id);
    const coverageOrder = coverage.map((line) => line.source_line_id);

    if (!sameArray(filingOrder, manifestOrder)) {
      findings.push(
        finding(
          "evidence.statement.extraction_order_mismatch",
          "BLOCK",
          `${section} extracted filing ledger does not exactly preserve manifest membership and source order.`,
          { manifest_order: manifestOrder, extraction_order: filingOrder },
        ),
      );
    }
    if (!sameArray(coverageOrder, manifestOrder)) {
      findings.push(
        finding(
          "evidence.statement.coverage_order_mismatch",
          "BLOCK",
          `${section} source coverage does not exactly preserve manifest membership and source order.`,
          { manifest_order: manifestOrder, coverage_order: coverageOrder },
        ),
      );
    }

    const filingById = new Map();
    for (const line of filingLines) {
      if (filingById.has(line.source_line_id)) {
        findings.push(
          finding(
            "evidence.statement.extraction_duplicate_line",
            "BLOCK",
            `${section}.${line.source_line_id} appears more than once in the extracted filing ledger.`,
          ),
        );
      }
      filingById.set(line.source_line_id, line);
      if (!manifestById.has(line.source_line_id)) {
        findings.push(
          finding(
            "evidence.statement.extraction_not_in_manifest",
            "BLOCK",
            `${section}.${line.source_line_id} is extracted but absent from the authoritative face-statement manifest.`,
          ),
        );
      }
    }
    const coverageSeen = new Set();
    for (const line of coverage) {
      if (coverageSeen.has(line.source_line_id)) {
        findings.push(
          finding(
            "evidence.statement.coverage_duplicate_line",
            "BLOCK",
            `${section}.${line.source_line_id} appears more than once in source coverage.`,
          ),
        );
      }
      coverageSeen.add(line.source_line_id);
      if (!manifestById.has(line.source_line_id)) {
        findings.push(
          finding(
            "evidence.statement.coverage_not_in_manifest",
            "BLOCK",
            `${section}.${line.source_line_id} is covered but absent from the authoritative face-statement manifest.`,
          ),
        );
      }
    }

    const exactLineageOwners = new Map();
    for (const entry of manifestEntries) {
      const manifestRow = entry.row;
      const filingLine = filingById.get(manifestRow.source_line_id);
      const disclosure = coverageById.get(manifestRow.source_line_id);
      if (!filingLine) {
        findings.push(
          finding(
            "evidence.statement.manifest_not_extracted",
            "BLOCK",
            `${section}.${manifestRow.source_line_id} exists in the face-statement manifest but is absent from the extracted filing ledger.`,
          ),
        );
      } else {
        const sameLine =
          filingLine.source_id === entry.source_id &&
          filingLine.page_or_note === manifestRow.page_or_note &&
          filingLine.face_statement === true &&
          filingLine.material === manifestRow.material &&
          normalizedStatementLabel(filingLine.label) ===
            normalizedStatementLabel(manifestRow.raw_label) &&
          JSON.stringify(filingLine.values) === JSON.stringify(manifestRow.values);
        if (!sameLine) {
          findings.push(
            finding(
              "evidence.statement.manifest_extraction_mismatch",
              "BLOCK",
              `${section}.${manifestRow.source_line_id} differs between the manifest and extracted filing ledger.`,
            ),
          );
        }
      }
      if (!disclosure) {
        findings.push(
          finding(
            "evidence.statement.manifest_not_covered",
            "BLOCK",
            `${section}.${manifestRow.source_line_id} exists in the face-statement manifest but has no source-coverage disposition.`,
          ),
        );
        continue;
      }
      const sameCoverageIdentity =
        disclosure.document === entry.source_id &&
        disclosure.page_or_note === manifestRow.page_or_note &&
        disclosure.face_statement === true &&
        disclosure.material === manifestRow.material &&
        normalizedStatementLabel(disclosure.label) ===
          normalizedStatementLabel(manifestRow.raw_label);
      if (!sameCoverageIdentity) {
        findings.push(
          finding(
            "evidence.statement.manifest_coverage_mismatch",
            "BLOCK",
            `${section}.${manifestRow.source_line_id} differs between the manifest and source coverage.`,
          ),
        );
      }

      if (["mapped", "aggregated"].includes(disclosure.disposition)) {
        const exactRows = (disclosure.mapped_row_ids ?? [])
          .map((rowId) => rowsById.get(rowId))
          .filter(Boolean)
          .filter(
            (row) =>
              (row.source_line_ids ?? []).includes(manifestRow.source_line_id) &&
              normalizedStatementLabel(row.label) ===
                normalizedStatementLabel(manifestRow.raw_label),
          );
        if (exactRows.length === 0) {
          findings.push(
            finding(
              "evidence.statement.aggregation_lineage_incomplete",
              "BLOCK",
              `${section}.${manifestRow.source_line_id} is mapped without a visible issuer-labelled statement row carrying its source-line lineage.`,
            ),
          );
        }
        for (const row of exactRows) {
          const prior = exactLineageOwners.get(row.row_id);
          if (prior && prior !== manifestRow.source_line_id) {
            findings.push(
              finding(
                "evidence.statement.aggregation_lineage_collision",
                "BLOCK",
                `${section}.${row.row_id} is the sole issuer-labelled lineage row for both ${prior} and ${manifestRow.source_line_id}.`,
              ),
            );
          } else {
            exactLineageOwners.set(row.row_id, manifestRow.source_line_id);
          }
        }
      }
    }
    // The forward check below proves that every extracted filing line has a
    // disposition.  The reverse check is equally important: without it an
    // adapter can keep a large source-coverage graph while presenting only a
    // short, cherry-picked filings array to the numeric parity gate.
    for (const disclosure of coverage) {
      if (
        sourceIds.has(disclosure.document) &&
        !filingLineIds.has(disclosure.source_line_id)
      ) {
        findings.push(
          finding(
            "evidence.statement.coverage_not_extracted",
            "BLOCK",
            `${section}.${disclosure.source_line_id} exists in source coverage but is absent from the extracted filing-line ledger.`,
          ),
        );
      }
    }
    for (const line of filingLines) {
      if (!sourceIds.has(line.source_id)) {
        findings.push(
          finding(
            "evidence.statement.source_absent",
            "BLOCK",
            `${section}.${line.source_line_id} cites unknown source ${line.source_id}.`,
          ),
        );
      }
      const mapped = coverageById.get(line.source_line_id);
      if (!mapped) {
        findings.push(
          finding(
            "evidence.statement.line_orphaned",
            "BLOCK",
            `${section}.${line.source_line_id} (${line.label}) has no source-coverage disposition.`,
          ),
        );
        continue;
      }
      if (mapped.document !== line.source_id) {
        findings.push(
          finding(
            "evidence.statement.source_mismatch",
            "BLOCK",
            `${section}.${line.source_line_id} maps document ${mapped.document}, expected source id ${line.source_id}.`,
          ),
        );
      }
      const accounted =
        ["mapped", "aggregated"].includes(mapped.disposition) &&
        Array.isArray(mapped.mapped_row_ids) &&
        mapped.mapped_row_ids.length > 0;
      const explicitImmaterialOmission =
        mapped.disposition === "not_applicable" &&
        line.material === false &&
        typeof mapped.reason === "string" &&
        mapped.reason.trim() !== "";
      if (!accounted && !explicitImmaterialOmission) {
        findings.push(
          finding(
            "evidence.statement.disposition_invalid",
            "BLOCK",
            `${section}.${line.source_line_id} is neither mapped/aggregated nor an explained immaterial omission.`,
          ),
        );
      }
      for (const rowId of mapped.mapped_row_ids ?? []) {
        if (!structuralRows[section].has(rowId)) {
          findings.push(
            finding(
              "evidence.statement.mapped_row_absent",
              "BLOCK",
              `${section}.${line.source_line_id} maps to absent row ${rowId}.`,
            ),
          );
        }
      }
    }

    // Mapping existence is not numeric source parity.  A normalized case can
    // point every filing line at a real row and still carry a different number;
    // the solver and workbook will then agree perfectly with the wrong case.
    // Resolve the case's three historical columns independently here and tie
    // them back to the filing-line values before the case can enter the build.
    const resolvedSeries = resolveHistoricalStatementSeries(modelCase, section);
    const numericGroups = new Map();
    for (const line of filingLines) {
      const mapped = coverageById.get(line.source_line_id);
      if (!mapped || !["mapped", "aggregated"].includes(mapped.disposition)) {
        continue;
      }
      const comparable = [0, 1, 2].filter((index) => finite(line.values?.[index]));
      if (comparable.length === 0) continue;
      const mappedRowIds = [...new Set(mapped.mapped_row_ids ?? [])].sort();
      const key =
        mapped.disposition === "aggregated"
          ? `aggregate\u0000${mappedRowIds.join("\u0000")}`
          : `line\u0000${line.source_line_id}`;
      if (!numericGroups.has(key)) {
        numericGroups.set(key, {
          lines: [],
          mappedRowIds,
          mappingMethod: mapped.mapping_method ?? null,
        });
      }
      numericGroups.get(key).lines.push(line);
    }

    for (const group of numericGroups.values()) {
      const comparable = [0, 1, 2].filter((periodIndex) =>
        group.lines.every((line) => finite(line.values?.[periodIndex])),
      );
      if (comparable.length === 0) continue;
      const sourceSeries = [0, 1, 2].map((periodIndex) =>
        group.lines.every((line) => finite(line.values?.[periodIndex]))
          ? group.lines.reduce(
              (sum, line) => sum + Number(line.values[periodIndex]),
              0,
            )
          : null,
      );
      const candidates = group.mappedRowIds
        .map((rowId) => ({ rowId, values: resolvedSeries.get(rowId) }))
        .filter((candidate) => Array.isArray(candidate.values));
      const directMatch = candidates.find((candidate) =>
        seriesMatches(sourceSeries, candidate.values, comparable),
      );
      if (directMatch) continue;

      const mappedIds = new Set(group.mappedRowIds);
      const hasInternalDependency = group.mappedRowIds.some((rowId) =>
        (rowsById.get(rowId)?.calculation?.refs ?? []).some((ref) =>
          mappedIds.has(ref),
        ),
      );
      let splitSeries = null;
      if (!hasInternalDependency && candidates.length > 1) {
        splitSeries = [0, 1, 2].map((periodIndex) =>
          candidates.every((candidate) => finite(candidate.values?.[periodIndex]))
            ? candidates.reduce(
                (sum, candidate) => sum + Number(candidate.values[periodIndex]),
                0,
              )
            : null,
        );
        if (seriesMatches(sourceSeries, splitSeries, comparable)) continue;
      }

      findings.push(
        finding(
          "evidence.statement.numeric_parity",
          "BLOCK",
          `${section}.${group.lines.map((line) => line.source_line_id).join("+")} does not numerically reproduce in its mapped normalized row(s).`,
          {
            source_values: sourceSeries,
            mapped_rows: candidates.map((candidate) => ({
              row_id: candidate.rowId,
              values: candidate.values,
            })),
            split_sum: splitSeries,
            comparable_periods: comparable,
          },
        ),
      );
    }
  }

  for (const [rowId, entries] of Object.entries(modelCase.provenance ?? {})) {
    for (const entry of entries) {
      if (!sourceIds.has(entry.document)) {
        findings.push(
          finding(
            "evidence.provenance.source_absent",
            "BLOCK",
            `Provenance for ${rowId} cites unknown source ${entry.document}.`,
          ),
        );
      }
    }
  }
}

/**
 * Reusable statement-evidence gate for production and TEST_ONLY public-company
 * envelopes.  It validates the raw manifest, extraction, coverage, visible
 * lineage and historical numeric parity without importing either route's debt
 * or broker authority rules.
 */
export function validateStatementEvidence(run) {
  const findings = [];
  const sourceIds = new Set(
    (run?.source_inventory ?? []).map((source) => source.source_id),
  );
  validateStatementMapping(run, sourceIds, findings);
  return findings;
}

function validateDebtMapping(run, findings) {
  const caseById = new Map(
    (run.model_case?.instruments ?? []).map((instrument) => [
      instrument.instrument_id,
      instrument,
    ]),
  );
  for (const exported of run.dcs_export?.instruments ?? []) {
    const instrument = caseById.get(exported.instrument_id);
    if (!instrument) {
      findings.push(
        finding(
          "evidence.debt.instrument_dropped",
          "BLOCK",
          `Export instrument ${exported.instrument_id} is absent from the model case.`,
        ),
      );
      continue;
    }
    for (const [field, actual, expected] of [
      ["opening_balance", instrument.opening_balance, exported.outstanding_amount],
      ["class", instrument.class, exported.instrument_type],
      ["currency", instrument.currency, exported.currency],
      ["maturity_date", instrument.maturity_date ?? null, exported.maturity_date ?? null],
      ["rate_type", instrument.rate_type, exported.rate_type],
    ]) {
      const equal = finite(actual) && finite(expected)
        ? approximate(actual, expected)
        : actual === expected;
      const supplementField = field === "class" ? "instrument_type" : field;
      if (!equal && !hasSupplement(run, exported.instrument_id, supplementField)) {
        findings.push(
          finding(
            "evidence.debt.field_mismatch",
            "BLOCK",
            `${exported.instrument_id}.${field} is ${JSON.stringify(actual)} in the case and ${JSON.stringify(expected)} in the export, with no declared supplement.`,
          ),
        );
      }
    }
    if (
      exported.instrument_type === "rcf" &&
      !approximate(instrument.facility_capacity, exported.facility_limit)
    ) {
      findings.push(
        finding(
          "evidence.debt.rcf_capacity_mismatch",
          "BLOCK",
          `${exported.instrument_id} facility capacity does not match the normalized export.`,
        ),
      );
    }
  }

  const exportedIds = new Set(
    (run.dcs_export?.instruments ?? []).map((instrument) =>
      instrument.instrument_id,
    ),
  );
  for (const instrument of run.model_case?.instruments ?? []) {
    if (
      !exportedIds.has(instrument.instrument_id) &&
      instrument.is_residual_pool !== true
    ) {
      findings.push(
        finding(
          "evidence.debt.case_only_instrument",
          "BLOCK",
          `Case instrument ${instrument.instrument_id} is not in the export and is not an explicit residual pool.`,
        ),
      );
    }
  }

  const reported = Number(run.filings?.reported_gross_debt);
  const caseReported = Number(
    run.model_case?.debt_reconciliation?.reported_opening_gross_debt,
  );
  if (!approximate(reported, caseReported)) {
    findings.push(
      finding(
        "evidence.debt.reported_total_mismatch",
        "BLOCK",
        `Case reported gross debt ${caseReported} does not equal the filings total ${reported}.`,
      ),
    );
  }
}

function expectedConsensus(pack, metricId, forecastIndex) {
  const provider = pack.provider_consensus?.[metricId]?.[forecastIndex];
  if (
    provider !== null &&
    provider !== undefined &&
    Number.isFinite(Number(provider))
  ) {
    return Number(provider);
  }
  const values = (pack.houses ?? [])
    .map((house) => house.estimates?.[metricId]?.[forecastIndex])
    .filter(
      (value) =>
        value !== null &&
        value !== undefined &&
        Number.isFinite(Number(value)),
    )
    .map(Number);
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function validateBrokerMapping(run, findings) {
  const source = run.broker_pack ?? {};
  const target = run.model_case?.broker_pack ?? {};
  if (!sameArray(source.forecast_periods, target.forecast_periods)) {
    findings.push(
      finding(
        "evidence.broker.period_mismatch",
        "BLOCK",
        "The model-case broker periods do not match the normalized broker pack.",
      ),
    );
  }
  for (const metricId of Object.keys(source.metrics ?? {})) {
    const metric = target.metrics?.[metricId];
    if (!metric) {
      findings.push(
        finding(
          "evidence.broker.metric_dropped",
          "BLOCK",
          `Broker metric ${metricId} is absent from the model case.`,
        ),
      );
      continue;
    }
    for (const house of source.houses ?? []) {
      const expected = house.estimates?.[metricId];
      if (!Array.isArray(expected)) continue;
      const actual = metric.brokers?.[house.house_name];
      if (!sameArray(actual, expected)) {
        findings.push(
          finding(
            "evidence.broker.house_series_mismatch",
            "BLOCK",
            `${metricId} for ${house.house_name} does not match the normalized broker source.`,
          ),
        );
      }
      const metadata = target.house_metadata?.[house.house_name];
      const inventorySource = (run.source_inventory ?? []).find(
        (entry) =>
          entry.kind === "user_broker_research" &&
          entry.name === house.document?.file_name,
      );
      if (
        !metadata ||
        metadata.published_date !== house.published_date ||
        metadata.document !== house.document?.file_name ||
        !inventorySource ||
        metadata.source_id !== inventorySource.source_id
      ) {
        findings.push(
          finding(
            "evidence.broker.house_metadata_mismatch",
            "BLOCK",
            `Publication metadata for ${house.house_name} was not preserved in the model case.`,
          ),
        );
      }
    }
    for (let index = 0; index < 3; index += 1) {
      const expected = expectedConsensus(source, metricId, index);
      const actual = metric.provider_consensus?.[index];
      if (
        expected !== null &&
        (actual === null ||
          actual === undefined ||
          !approximate(actual, expected))
      ) {
        findings.push(
          finding(
            "evidence.broker.consensus_mismatch",
            "BLOCK",
            `${metricId} consensus for forecast period ${index + 1} does not match the provider line or the named-house mean.`,
          ),
        );
      }
    }
  }
}

function validateRestatements(run, sourceIds, findings) {
  const historical = run.filings?.historical_periods ?? [];
  const decisions = run.decisions?.restatements ?? [];
  const inventory = new Map(
    (run.source_inventory ?? []).map((source) => [source.source_id, source]),
  );
  const filingKinds = new Set([
    "company_annual_report",
    "company_interim_update",
  ]);
  for (const period of historical) {
    const entries = decisions.filter((entry) => entry.period === period);
    if (entries.length !== 1) {
      findings.push(
        finding(
          "evidence.restatement.period_decision",
          "BLOCK",
          `Historical period ${period} requires exactly one basis decision; found ${entries.length}.`,
        ),
      );
      continue;
    }
    const entry = entries[0];
    for (const sourceId of entry.source_ids ?? []) {
      if (!sourceIds.has(sourceId)) {
        findings.push(
          finding(
            "evidence.restatement.source_absent",
            "BLOCK",
            `Restatement decision for ${period} cites unknown source ${sourceId}.`,
          ),
        );
        continue;
      }
      const source = inventory.get(sourceId);
      if (source?.status !== "used") {
        findings.push(
          finding(
            "evidence.restatement.source_not_used",
            "BLOCK",
            `Restatement decision for ${period} cites ${sourceId}, but that source is ${source?.status ?? "unavailable"} rather than used.`,
          ),
        );
      }
      if (!filingKinds.has(source?.kind)) {
        findings.push(
          finding(
            "evidence.restatement.source_kind_invalid",
            "BLOCK",
            `Restatement decision for ${period} must be supported by a company filing; ${sourceId} is ${source?.kind ?? "unknown"}.`,
          ),
        );
      }
    }
    const requiresBridge = [
      "restated_comparative",
      "predecessor_combined",
      "calendarised",
    ].includes(entry.basis);
    if (requiresBridge && entry.bridge_status !== "complete") {
      findings.push(
        finding(
          "evidence.restatement.bridge_incomplete",
          "BLOCK",
          `${period} uses ${entry.basis} but its explicit bridge is not complete.`,
        ),
      );
    }
    if (!requiresBridge) continue;

    const bridge = entry.numeric_bridge;
    if (!bridge || !Array.isArray(bridge.metrics) || bridge.metrics.length === 0) {
      findings.push(
        finding(
          "evidence.restatement.bridge_missing",
          "BLOCK",
          `${period} uses ${entry.basis} but has no non-empty numeric bridge.`,
        ),
      );
      continue;
    }

    const expectedDigest = historicalBridgeDigest(run, entry);
    if (bridge.bridge_sha256 !== expectedDigest) {
      findings.push(
        finding(
          "evidence.restatement.bridge_hash_mismatch",
          "BLOCK",
          `${period} numeric bridge is not bound to its current terms, basis and source hashes.`,
          { expected_sha256: expectedDigest, actual_sha256: bridge.bridge_sha256 ?? null },
        ),
      );
    }

    const decisionSources = new Set(entry.source_ids ?? []);
    for (const bridgeSourceId of bridgeMetricSourceIds(bridge)) {
      if (!decisionSources.has(bridgeSourceId)) {
        findings.push(
          finding(
            "evidence.restatement.bridge_source_not_declared",
            "BLOCK",
            `${period} numeric bridge cites ${bridgeSourceId}, which is not declared by the basis decision.`,
          ),
        );
      }
    }

    const metricIds = new Set();
    const periodIndex = historical.indexOf(period);
    for (const metric of bridge.metrics) {
      if (metricIds.has(metric.metric_id)) {
        findings.push(
          finding(
            "evidence.restatement.bridge_metric_duplicate",
            "BLOCK",
            `${period} numeric bridge repeats metric ${metric.metric_id}.`,
          ),
        );
      }
      metricIds.add(metric.metric_id);

      const adjustmentIds = new Set();
      for (const adjustment of metric.adjustments ?? []) {
        if (adjustmentIds.has(adjustment.adjustment_id)) {
          findings.push(
            finding(
              "evidence.restatement.bridge_adjustment_duplicate",
              "BLOCK",
              `${period} metric ${metric.metric_id} repeats adjustment ${adjustment.adjustment_id}.`,
            ),
          );
        }
        adjustmentIds.add(adjustment.adjustment_id);
      }

      const tolerance = Number(metric.tolerance);
      if (!finite(tolerance) || tolerance < 0 || tolerance > 1e-6) {
        findings.push(
          finding(
            "evidence.restatement.bridge_tolerance_invalid",
            "BLOCK",
            `${period} metric ${metric.metric_id} tolerance must be explicit and no greater than 0.000001.`,
          ),
        );
        continue;
      }
      const adjustmentValues = (metric.adjustments ?? []).map((item) => item.value);
      if (
        !finite(metric.reported_value) ||
        !finite(metric.selected_value) ||
        adjustmentValues.some((value) => !finite(value))
      ) {
        findings.push(
          finding(
            "evidence.restatement.bridge_non_numeric",
            "BLOCK",
            `${period} metric ${metric.metric_id} bridge contains a non-numeric term.`,
          ),
        );
        continue;
      }
      const bridgedValue = Number(metric.reported_value) +
        adjustmentValues.reduce((total, value) => total + Number(value), 0);
      if (!approximate(bridgedValue, metric.selected_value, tolerance)) {
        findings.push(
          finding(
            "evidence.restatement.bridge_arithmetic_mismatch",
            "BLOCK",
            `${period} metric ${metric.metric_id} does not reconcile: reported value plus named adjustments is ${bridgedValue}, not selected value ${metric.selected_value}.`,
            { bridged_value: bridgedValue, selected_value: metric.selected_value, tolerance },
          ),
        );
      }

      const canonical = canonicalHistoricalValue(
        run.model_case,
        metric.canonical_path,
        metric.metric_id,
        periodIndex,
      );
      if (canonical.error) {
        findings.push(
          finding(
            "evidence.restatement.bridge_canonical_path_invalid",
            "BLOCK",
            `${period} metric ${metric.metric_id}: ${canonical.error}`,
          ),
        );
      } else if (!approximate(canonical.value, metric.selected_value, tolerance)) {
        findings.push(
          finding(
            "evidence.restatement.bridge_case_mismatch",
            "BLOCK",
            `${period} metric ${metric.metric_id} selected value ${metric.selected_value} does not equal model_case value ${canonical.value}.`,
            { model_case_value: canonical.value, selected_value: metric.selected_value, tolerance },
          ),
        );
      }
    }
  }
}

function validateDecisionSources(run, sourceIds, findings) {
  const inventory = new Map(
    (run.source_inventory ?? []).map((source) => [source.source_id, source]),
  );
  for (const section of ["groupings", "stated_assumptions"]) {
    for (const decision of run.decisions?.[section] ?? []) {
      for (const sourceId of decision.source_ids ?? []) {
        if (!sourceIds.has(sourceId)) {
          findings.push(
            finding(
              "evidence.decision.source_absent",
              "BLOCK",
              `${section} decision ${decision.decision_id} cites unknown source ${sourceId}.`,
            ),
          );
        }
      }
    }
  }
  for (const supplement of run.decisions?.manual_debt_supplements ?? []) {
    const source = inventory.get(supplement.source_id);
    if (!source) {
      findings.push(
        finding(
          "evidence.debt.supplement_source_absent",
          "BLOCK",
          `Debt supplement ${supplement.instrument_id}.${supplement.field} cites unknown source ${supplement.source_id}.`,
        ),
      );
      continue;
    }
    const validKind = supplement.basis === "user_answer"
      ? source.kind === "user_answer"
      : [
          "company_annual_report",
          "company_interim_update",
          "company_debt_document",
          "company_transaction_announcement",
        ].includes(source.kind);
    if (!validKind) {
      findings.push(
        finding(
          "evidence.debt.supplement_basis_mismatch",
          "BLOCK",
          `Debt supplement ${supplement.instrument_id}.${supplement.field} declares basis ${supplement.basis} but source ${supplement.source_id} is ${source.kind}.`,
        ),
      );
    }
  }

  if (run.mode === "rebuild" && run.prior_case_receipt) {
    const prior = (run.source_inventory ?? []).find(
      (source) => source.kind === "prior_case" && source.status === "used",
    );
    if (
      prior &&
      prior.content_sha256 !== run.prior_case_receipt.case_sha256
    ) {
      findings.push(
        finding(
          "evidence.rebuild.hash_mismatch",
          "BLOCK",
          "The prior-case source hash does not match the rebuild receipt.",
        ),
      );
    }
    compareEntity(
      findings,
      "evidence.rebuild.entity_mismatch",
      run.prior_case_receipt.issuer_name,
      run.company_name,
    );
    const preserved = [...(run.prior_case_receipt.answers_preserved ?? [])].sort();
    const carried = Object.keys(run.model_case?.stage_three_answers ?? {}).sort();
    if (!sameArray(preserved, carried)) {
      findings.push(
        finding(
          "evidence.rebuild.answers_mismatch",
          "BLOCK",
          "The rebuild receipt's preserved answer IDs do not exactly match the settled answers carried by the case.",
          { preserved, carried },
        ),
      );
    }
  }
}

/**
 * Validate the complete deployment host evidence-to-case handoff. No workbook or solver
 * result is trusted here; this gate only decides whether the deterministic
 * user flow is allowed to start.
 */
export function validateEvidenceRun(run) {
  const findings = [];
  for (const message of validateJsonSchema(run, EVIDENCE_SCHEMA)) {
    findings.push(finding("evidence.schema", "BLOCK", message));
  }
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    return { ok: false, status: "BLOCK", findings, errors: findings };
  }

  const sourceIds = validateSourceInventory(run, findings);
  validateAttachmentIngress(run, findings);
  const modelCase = run.model_case ?? {};
  const caseErrors = validateCaseShape(modelCase);
  for (const message of caseErrors) {
    findings.push(finding("evidence.model_case.schema", "BLOCK", message));
  }

  const historical = modelPeriods(modelCase, "historical");
  const forecast = modelPeriods(modelCase, "forecast");
  if (!sameArray(historical, run.filings?.historical_periods)) {
    findings.push(
      finding(
        "evidence.periods.historical_mismatch",
        "BLOCK",
        "The model case historical periods do not match the selected filings basis.",
      ),
    );
  }
  if (!sameArray(forecast, run.filings?.forecast_periods)) {
    findings.push(
      finding(
        "evidence.periods.forecast_mismatch",
        "BLOCK",
        "The model case forecast periods do not match the evidence run.",
      ),
    );
  }

  compareEntity(findings, "evidence.entity.case", run.company_name, modelCase.issuer?.name);
  compareEntity(findings, "evidence.entity.filings", run.company_name, run.filings?.entity_name);
  compareEntity(findings, "evidence.entity.export", run.filings?.entity_name, run.dcs_export?.entity?.name);

  const intake = runIntake({
    companyName: run.company_name,
    dcsExport: run.dcs_export,
    brokerPack: run.broker_pack,
    expected: {
      last_historical_period_end: historical.at(-1) ?? null,
      forecast_period_ends: forecast,
      reporting_currency: run.filings?.reporting_currency ?? null,
      units: run.filings?.units ?? null,
      reported_gross_debt: run.filings?.reported_gross_debt ?? null,
      issuer_name: modelCase.issuer?.name ?? run.company_name,
    },
  });
  for (const entry of intake.errors) {
    findings.push(
      finding(
        `evidence.intake.${entry.code}`,
        "BLOCK",
        entry.message,
        entry.detail ?? null,
      ),
    );
  }

  validateStatementMapping(run, sourceIds, findings);
  validateDebtMapping(run, findings);
  validateBrokerMapping(run, findings);
  validateRestatements(run, sourceIds, findings);
  validateDecisionSources(run, sourceIds, findings);

  const coverage = caseErrors.length === 0 ? assessCoverage(modelCase) : null;
  if (coverage && !coverage.ready_to_build) {
    for (const check of coverage.checks.filter((entry) => entry.status === "BLOCK")) {
      findings.push(
        finding(
          `evidence.coverage.${check.id}`,
          "BLOCK",
          check.detail ?? check.message ?? "Coverage gate blocked.",
        ),
      );
    }
  }

  const errors = findings.filter((entry) => entry.severity === "BLOCK");
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS" : "BLOCK",
    findings,
    errors,
    intake,
    coverage,
    handoff: errors.length === 0
      ? {
          intake: {
            company_name: run.company_name,
            export: run.dcs_export,
            broker_pack: run.broker_pack,
            filings: {
              entity_name: run.filings.entity_name,
              fiscal_year_end_date: run.filings.historical_periods.at(-1),
              fiscal_label: run.filings.fiscal_label ?? null,
              reported_gross_debt: run.filings.reported_gross_debt,
              reported_cash: run.filings.reported_cash,
              maximum_residual_percentage:
                run.filings.maximum_residual_percentage ?? 0.01,
              restricted_cash: run.filings.restricted_cash ?? null,
              leverage_basis: run.filings.leverage_basis ?? null,
              minimum_operating_cash: run.filings.minimum_operating_cash ?? null,
              announced_acquisition: run.filings.announced_acquisition ?? null,
            },
          },
          model_case: modelCase,
        }
      : null,
  };
}

export default { validateEvidenceRun };
