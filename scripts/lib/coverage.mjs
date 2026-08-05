import fs from "node:fs";
import { compiledCashFlowRoles, normaliseStatementRows } from "./row_plan.mjs";
import { classifyStatementLine, isHighImpactRole } from "./statement_classifier.mjs";

const PRODUCTION_CONTRACT = JSON.parse(
  fs.readFileSync(
    new URL("../../assets/production-contract-v2.json", import.meta.url),
    "utf8",
  ),
);

function number(value) {
  return Number(value);
}

function finite(value) {
  return Number.isFinite(number(value));
}

function series(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => item === null || finite(item))
  );
}

function result(id, status, message, detail = null) {
  return { id, status, message, detail };
}

function allStatementRows(modelCase) {
  return [
    ...(modelCase.statement_structure?.income_statement ?? []),
    ...(modelCase.statement_structure?.cash_flow ?? []),
  ];
}

function classificationChecks(disclosure, section, rows) {
  const checks = [];
  const id = disclosure.source_line_id ?? "missing";
  const classification = classifyStatementLine({ ...disclosure, section });
  const declaredRole = disclosure.classified_role;
  const highImpact = isHighImpactRole(declaredRole) ||
    classification.candidates.some((candidate) => isHighImpactRole(candidate.role));
  const materialOrHighImpact = disclosure.material === true || highImpact;
  if (!materialOrHighImpact) return checks;
  if (!["accepted", "manual_reviewed"].includes(disclosure.classification_status)) {
    checks.push(result(
      `classification.${id}.status`, "BLOCK",
      `${disclosure.label ?? id} has no accepted or reviewed semantic classification.`,
    ));
    return checks;
  }
  if (!Array.isArray(disclosure.classification_evidence) || disclosure.classification_evidence.length === 0 ||
      !Array.isArray(disclosure.classification_candidates) || disclosure.classification_candidates.length === 0 ||
      typeof disclosure.classifier_version !== "string" || !disclosure.classifier_version.trim()) {
    checks.push(result(
      `classification.${id}.evidence`, "BLOCK",
      `${disclosure.label ?? id} is material but has no complete classification evidence bundle.`,
    ));
  }
  if (disclosure.classification_status === "accepted") {
    if (disclosure.classification_review_status !== "auto_accepted" && disclosure.classification_review_status !== "reviewed") {
      checks.push(result(`classification.${id}.review`, "BLOCK", `${disclosure.label ?? id} is accepted without an acceptance/review state.`));
    }
    if (classification.status !== "accepted" || classification.classified_role !== declaredRole ||
        Number(disclosure.classification_confidence) !== classification.confidence) {
      checks.push(result(
        `classification.${id}.reproducibility`, "BLOCK",
        `${disclosure.label ?? id} cannot reproduce its declared classification from its preserved source evidence.`,
        { expected: classification, declared_role: declaredRole, declared_confidence: disclosure.classification_confidence },
      ));
    }
    const mappedRoles = disclosure.mapped_row_ids
      .map((rowId) => rows.find((row) => row.row_id === rowId)?.semantic_role)
      .filter(Boolean);
    if (mappedRoles.length > 0 && !mappedRoles.includes(declaredRole)) {
      checks.push(result(
        `classification.${id}.destination`, "BLOCK",
        `${disclosure.label ?? id} is classified as ${declaredRole} but maps to a different semantic role.`,
        { classified_role: declaredRole, mapped_roles: mappedRoles },
      ));
    }
  } else if (disclosure.classification_review_status !== "reviewed" ||
      typeof disclosure.reason !== "string" || !disclosure.reason.trim()) {
    checks.push(result(
      `classification.${id}.manual_review`, "BLOCK",
      `${disclosure.label ?? id} is manually classified without a reviewed, documented rationale.`,
    ));
  }
  return checks;
}

function statementCoverageChecks(modelCase) {
  const checks = [];
  const coverage = modelCase.source_coverage;
  if (!coverage) {
    return [
      result(
        "source_coverage",
        "BLOCK",
        "A complete source-to-statement coverage graph is required before build.",
      ),
    ];
  }
  if (
    coverage.status !==
    PRODUCTION_CONTRACT.statement_coverage.required_status
  ) {
    checks.push(
      result(
        "source_coverage.status",
        "BLOCK",
        "The source-to-statement inventory has not been reviewed as complete.",
      ),
    );
  }
  if (
    typeof coverage.review_evidence !== "string" ||
    !coverage.review_evidence.trim()
  ) {
    checks.push(
      result(
        "source_coverage.review_evidence",
        "BLOCK",
        "Statement-completeness review evidence is required.",
      ),
    );
  }
  const allRows = allStatementRows(modelCase);
  const rowIds = new Set(allRows.map((row) => row.row_id));
  const seenSourceIds = new Set();
  for (const section of ["income_statement", "cash_flow"]) {
    const disclosures = coverage[section] ?? [];
    if (disclosures.length === 0) {
      checks.push(
        result(
          `source_coverage.${section}.empty`,
          "BLOCK",
          `${section} has no source disclosure inventory.`,
        ),
      );
      continue;
    }
    let faceStatementLines = 0;
    let coveredFaceStatementLines = 0;
    for (const disclosure of disclosures) {
      const id = disclosure.source_line_id ?? "missing";
      if (seenSourceIds.has(id)) {
        checks.push(
          result(
            `source_coverage.${id}.duplicate`,
            "BLOCK",
            `Source disclosure identifier ${id} is duplicated.`,
          ),
        );
      }
      seenSourceIds.add(id);
      if (disclosure.face_statement === true) faceStatementLines += 1;
      const mappedIds = disclosure.mapped_row_ids ?? [];
      if (coverage.classification_contract_version === "evidence_v1") {
        checks.push(...classificationChecks(disclosure, section, allRows));
      }
      const mappedDisposition = ["mapped", "aggregated"].includes(
        disclosure.disposition,
      );
      if (mappedDisposition && mappedIds.length === 0) {
        checks.push(
          result(
            `source_coverage.${id}.unmapped`,
            "BLOCK",
            `${disclosure.label ?? id} has no mapped model row.`,
          ),
        );
      }
      const missingRows = mappedIds.filter((rowId) => !rowIds.has(rowId));
      if (missingRows.length > 0) {
        checks.push(
          result(
            `source_coverage.${id}.missing_rows`,
            "BLOCK",
            `${disclosure.label ?? id} maps to nonexistent model rows.`,
            missingRows,
          ),
        );
      }
      if (
        disclosure.disposition === "aggregated" &&
        (typeof disclosure.reason !== "string" || !disclosure.reason.trim())
      ) {
        checks.push(
          result(
            `source_coverage.${id}.aggregation_reason`,
            "BLOCK",
            `${disclosure.label ?? id} is aggregated without a documented reason.`,
          ),
        );
      }
      if (
        disclosure.disposition === "not_applicable" &&
        (disclosure.material === true ||
          typeof disclosure.reason !== "string" ||
          !disclosure.reason.trim())
      ) {
        checks.push(
          result(
            `source_coverage.${id}.invalid_omission`,
            "BLOCK",
            `${disclosure.label ?? id} cannot be omitted without a non-material, documented rationale.`,
          ),
        );
      }
      if (
        disclosure.face_statement === true &&
        mappedDisposition &&
        mappedIds.length > 0 &&
        missingRows.length === 0
      ) {
        coveredFaceStatementLines += 1;
      }
    }
    const ratio =
      faceStatementLines === 0
        ? 0
        : coveredFaceStatementLines / faceStatementLines;
    checks.push(
      result(
        `source_coverage.${section}.face_statement`,
        ratio >=
          PRODUCTION_CONTRACT.statement_coverage
            .required_face_statement_coverage
          ? "PASS"
          : "BLOCK",
        ratio >=
          PRODUCTION_CONTRACT.statement_coverage
            .required_face_statement_coverage
          ? `${section} maps every face-statement line.`
          : `${section} does not map every face-statement line.`,
        { faceStatementLines, coveredFaceStatementLines, ratio },
      ),
    );
  }
  return checks;
}

function requiredRoleChecks(modelCase) {
  const checks = [];
  const sections = {
    income_statement:
      PRODUCTION_CONTRACT.statement_coverage.required_income_statement_roles,
    cash_flow:
      PRODUCTION_CONTRACT.statement_coverage.required_cash_flow_roles,
  };
  for (const [section, requiredRoles] of Object.entries(sections)) {
    const present = new Set(
      (modelCase.statement_structure?.[section] ?? [])
        .map((row) => row.semantic_role)
        .filter(Boolean),
    );
    if (section === "cash_flow") {
      // The consolidation dynamics ADD the consolidated working-capital and
      // change-in-debt lines where the company reports only the constituents.
      // A role the compiler supplies is not a coverage gap.
      for (const role of compiledCashFlowRoles(modelCase)) present.add(role);
    }
    for (const role of requiredRoles) {
      const optional =
        role === "dividends" &&
        modelCase.coverage_policy?.dividends_not_relevant === true;
      if (!present.has(role) && !optional) {
        checks.push(
          result(
            `statement_role.${section}.${role}`,
            "BLOCK",
            `${section} is missing required semantic role ${role}.`,
          ),
        );
      }
    }
  }
  return checks;
}

function dependencyChecks(modelCase) {
  const checks = [];
  const rows = allStatementRows(modelCase);
  const ids = new Set();
  const definitions = new Map();
  const approvedCompilerRoles = new Set(
    PRODUCTION_CONTRACT.formula_dependency.approved_compiler_calculated_roles,
  );
  for (const row of rows) {
    if (ids.has(row.row_id)) {
      checks.push(
        result(
          `dependency.${row.row_id}.duplicate`,
          "BLOCK",
          `Statement row identifier ${row.row_id} is duplicated.`,
        ),
      );
    }
    ids.add(row.row_id);
    definitions.set(row.row_id, row);
  }
  for (const row of rows) {
    const calculation = row.calculation;
    const forecastCalculation = row.forecast_calculation;
    const forecastPeriodCalculations =
      row.forecast_period_calculations ?? [];
    const compilerCalculated = approvedCompilerRoles.has(row.semantic_role);
    if (
      ["calculation", "subtotal"].includes(row.row_type) &&
      !calculation &&
      !compilerCalculated
    ) {
      checks.push(
        result(
          `dependency.${row.row_id}.missing_formula`,
          "BLOCK",
          `${row.label} is a calculation row without declared dependencies.`,
        ),
      );
    }
    if (row.row_type === "subtotal" && !calculation) {
      checks.push(
        result(
          `dependency.${row.row_id}.hardcoded_subtotal`,
          "BLOCK",
          `${row.label} is a subtotal without a formula.`,
        ),
      );
    }
    if (row.row_type === "input" && calculation) {
      checks.push(
        result(
          `dependency.${row.row_id}.mixed_input_formula`,
          "BLOCK",
          `${row.label} is classified as both an input and a calculation.`,
        ),
      );
    }
    if (
      (forecastCalculation || forecastPeriodCalculations.some(Boolean)) &&
      row.forecast_treatment !== "formula"
    ) {
      checks.push(
        result(
          `dependency.${row.row_id}.forecast_formula_treatment`,
          "BLOCK",
          `${row.label} declares a forecast formula without formula forecast treatment.`,
        ),
      );
    }
    if (
      calculation &&
      calculation.refs.length === 0 &&
      !compilerCalculated
    ) {
      checks.push(
        result(
          `dependency.${row.row_id}.empty_refs`,
          "BLOCK",
          `${row.label} has an empty calculation dependency list.`,
        ),
      );
    }
    const missingRefs = (calculation?.refs ?? []).filter(
      (reference) => !ids.has(reference),
    );
    const missingForecastRefs = (forecastCalculation?.refs ?? []).filter(
      (reference) => !ids.has(reference),
    );
    const missingPeriodForecastRefs = forecastPeriodCalculations
      .flatMap((periodCalculation) => periodCalculation?.refs ?? [])
      .filter((reference) => !ids.has(reference));
    if (missingRefs.length > 0) {
      checks.push(
        result(
          `dependency.${row.row_id}.unresolved_refs`,
          "BLOCK",
          `${row.label} references nonexistent statement rows.`,
          missingRefs,
        ),
      );
    }
    if (missingForecastRefs.length > 0 || missingPeriodForecastRefs.length > 0) {
      checks.push(
        result(
          `dependency.${row.row_id}.unresolved_forecast_refs`,
          "BLOCK",
          `${row.label} has forecast dependencies that do not resolve.`,
          [...new Set([
            ...missingForecastRefs,
            ...missingPeriodForecastRefs,
          ])],
        ),
      );
    }
    if (
      row.row_type === "uncalculated" &&
      (row.values ?? [])
        .slice(3)
        .some((value) => value !== null && value !== undefined)
    ) {
      checks.push(
        result(
          `dependency.${row.row_id}.uncalculated_values`,
          "BLOCK",
          `${row.label} is intentionally uncalculated but contains forecast values.`,
        ),
      );
    }
  }
  function cycleCheck(mode, referencesForDefinition) {
    const visiting = new Set();
    const visited = new Set();
    const cycleNodes = new Set();
    function visit(id) {
      if (visiting.has(id)) {
        cycleNodes.add(id);
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      const definition = definitions.get(id);
      for (const reference of referencesForDefinition(definition)) {
        visit(reference);
      }
      visiting.delete(id);
      visited.add(id);
    }
    for (const id of definitions.keys()) visit(id);
    if (cycleNodes.size > 0) {
      checks.push(
        result(
          `dependency.statement_cycle.${mode}`,
          "BLOCK",
          `The ${mode} statement dependency graph contains an unapproved cycle.`,
          [...cycleNodes],
        ),
      );
    }
  }
  // A prior_period reference is a TEMPORAL edge, not an intra-period one: the
  // cell depends on the previous column, which is already solved by the time
  // this column is evaluated. Treating it as a same-period dependency reports
  // every flat carry-forward and every roll-forward as a false cycle.
  const intraPeriodRefs = (calculation) =>
    !calculation || calculation.operator === "prior_period"
      ? []
      : calculation.operator === "prior_period_scaled_by"
        ? calculation.refs?.slice(1) ?? []
      : calculation.refs ?? [];

  cycleCheck("historical", (definition) =>
    intraPeriodRefs(definition?.calculation),
  );
  for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
    cycleCheck("forecast", (definition) => {
      if (Array.isArray(definition?.forecast_period_calculations)) {
        return intraPeriodRefs(
          definition.forecast_period_calculations[forecastIndex],
        );
      }
      if (definition?.forecast_calculation) {
        return intraPeriodRefs(definition.forecast_calculation);
      }
      if (
        ["broker", "hardcode", "zero", "uncalculated"].includes(
          definition?.forecast_treatment,
        )
      ) {
        return [];
      }
      return intraPeriodRefs(definition?.calculation);
    });
  }
  return checks;
}

function statementHierarchyChecks(modelCase) {
  const checks = [];
  const suppliedRows = allStatementRows(modelCase);
  const hierarchyDeclared = suppliedRows.some(
    (row) =>
      row.parent_row_id ||
      row.aggregation_authority ||
      row.aggregation_role ||
      row.economic_class ||
      row.operation_scope,
  );
  if (hierarchyDeclared && !modelCase.issuer?.accounting_basis) {
    checks.push(
      result(
        "statement_hierarchy.accounting_basis",
        "BLOCK",
        "A case using statement hierarchy metadata must declare the issuer's accounting basis.",
      ),
    );
  }
  for (const section of ["income_statement", "cash_flow"]) {
    const rows = modelCase.statement_structure?.[section] ?? [];
    const byId = new Map(rows.map((row) => [row.row_id, row]));
    const childrenByParent = new Map();
    for (const row of rows) {
      if (row.operation_scope === "combined" && !row.scope_reconciliation_note) {
        checks.push(
          result(
            `statement_hierarchy.${section}.${row.row_id}.combined_scope`,
            "BLOCK",
            `${row.label} combines operating scopes without a reconciliation note.`,
          ),
        );
      }
      if (!row.parent_row_id) {
        if (
          row.aggregation_role &&
          row.aggregation_role !== "standalone"
        ) {
          checks.push(
            result(
              `statement_hierarchy.${section}.${row.row_id}.orphan_role`,
              "BLOCK",
              `${row.label} declares a child aggregation role without a parent.`,
            ),
          );
        }
        continue;
      }
      const parent = byId.get(row.parent_row_id);
      if (!parent || row.parent_row_id === row.row_id) {
        checks.push(
          result(
            `statement_hierarchy.${section}.${row.row_id}.parent`,
            "BLOCK",
            `${row.label} has an unresolved or self-referential parent in ${section}.`,
          ),
        );
        continue;
      }
      if (!row.economic_class) {
        checks.push(
          result(
            `statement_hierarchy.${section}.${row.row_id}.economic_class`,
            "BLOCK",
            `${row.label} is a hierarchy child without an economic class.`,
          ),
        );
      }
      if (!childrenByParent.has(parent.row_id)) {
        childrenByParent.set(parent.row_id, []);
      }
      childrenByParent.get(parent.row_id).push(row);
    }

    for (const [parentId, children] of childrenByParent.entries()) {
      const parent = byId.get(parentId);
      const authority = parent.aggregation_authority;
      if (!['reported_parent', 'derived_from_children'].includes(authority)) {
        checks.push(
          result(
            `statement_hierarchy.${section}.${parentId}.authority`,
            "BLOCK",
            `${parent.label} has children but no reported-parent or derived-parent authority.`,
          ),
        );
        continue;
      }
      const expectedRole =
        authority === "reported_parent" ? "working_child" : "contributing_child";
      const wrongRoles = children
        .filter((child) => child.aggregation_role !== expectedRole)
        .map((child) => child.row_id);
      if (wrongRoles.length > 0) {
        checks.push(
          result(
            `statement_hierarchy.${section}.${parentId}.child_roles`,
            "BLOCK",
            `${parent.label} has children with roles inconsistent with its authority.`,
            wrongRoles,
          ),
        );
      }
      const childIds = children.map((child) => child.row_id).sort();
      if (authority === "reported_parent") {
        if (parent.calculation) {
          checks.push(
            result(
              `statement_hierarchy.${section}.${parentId}.reported_formula`,
              "BLOCK",
              `${parent.label} is a reported parent but also declares a formula.`,
            ),
          );
        }
        for (let periodIndex = 0; periodIndex < 3; periodIndex += 1) {
          const parentValue = parent.values?.[periodIndex];
          const childValues = children.map((child) => child.values?.[periodIndex]);
          if (
            parentValue === null ||
            parentValue === undefined ||
            childValues.some((value) => value === null || value === undefined)
          ) {
            continue;
          }
          const childTotal = childValues.reduce(
            (total, value) => total + Number(value),
            0,
          );
          if (Math.abs(Number(parentValue) - childTotal) > 1e-6) {
            checks.push(
              result(
                `statement_hierarchy.${section}.${parentId}.working_reconciliation.${periodIndex}`,
                "BLOCK",
                `${parent.label} does not reconcile to its disclosed workings in historical period ${periodIndex + 1}.`,
                { parent: Number(parentValue), children: childTotal },
              ),
            );
          }
        }
      } else {
        const refs = [...(parent.calculation?.refs ?? [])].sort();
        const exactChildren =
          parent.calculation?.operator === "sum" &&
          refs.length === childIds.length &&
          refs.every((ref, index) => ref === childIds[index]);
        if (!exactChildren) {
          checks.push(
            result(
              `statement_hierarchy.${section}.${parentId}.derived_formula`,
              "BLOCK",
              `${parent.label} is derived from children but does not sum exactly those children.`,
              { expected: childIds, actual: refs },
            ),
          );
        }
        if ((parent.values ?? []).slice(0, 3).some((value) => value !== null && value !== undefined)) {
          checks.push(
            result(
              `statement_hierarchy.${section}.${parentId}.derived_input`,
              "BLOCK",
              `${parent.label} is derived from children but also contains a reported parent input.`,
            ),
          );
        }
      }
      const childScopes = new Set(
        children.map((child) => child.operation_scope).filter(Boolean),
      );
      if (
        childScopes.size > 1 &&
        (parent.operation_scope !== "combined" || !parent.scope_reconciliation_note)
      ) {
        checks.push(
          result(
            `statement_hierarchy.${section}.${parentId}.scope_reconciliation`,
            "BLOCK",
            `${parent.label} combines children with different operating scopes without a combined-scope reconciliation.`,
            [...childScopes],
          ),
        );
      }
    }

    const visiting = new Set();
    const visited = new Set();
    const cycleNodes = new Set();
    const visit = (row) => {
      if (!row || visited.has(row.row_id)) return;
      if (visiting.has(row.row_id)) {
        cycleNodes.add(row.row_id);
        return;
      }
      visiting.add(row.row_id);
      visit(byId.get(row.parent_row_id));
      visiting.delete(row.row_id);
      visited.add(row.row_id);
    };
    for (const row of rows) visit(row);
    if (cycleNodes.size > 0) {
      checks.push(
        result(
          `statement_hierarchy.${section}.parent_cycle`,
          "BLOCK",
          `${section} contains a parent/child hierarchy cycle.`,
          [...cycleNodes],
        ),
      );
    }

    const compiled = normaliseStatementRows(modelCase, section);
    const workingChildIds = new Set(
      compiled
        .filter((row) => row.aggregation_role === "working_child")
        .map((row) => row.row_id),
    );
    const doubleCounted = [];
    for (const row of compiled) {
      for (const ref of row.calculation?.refs ?? []) {
        if (workingChildIds.has(ref)) {
          doubleCounted.push({ consumer: row.row_id, working_child: ref });
        }
      }
    }
    if (doubleCounted.length > 0) {
      checks.push(
        result(
          `statement_hierarchy.${section}.working_child_double_count`,
          "BLOCK",
          `${section} still feeds a reported-parent working child into a compiled total.`,
          doubleCounted,
        ),
      );
    }
  }
  return checks;
}

function historicalProvenanceChecks(modelCase) {
  const checks = [];
  const rows = [
    ...(modelCase.statement_structure?.income_statement ?? []),
    ...(modelCase.statement_structure?.cash_flow ?? []),
  ];
  const provenance = modelCase.provenance ?? {};
  for (const row of rows) {
    const literalHistorical =
      ["input", "uncalculated"].includes(row.row_type) ||
      (["calculation", "subtotal"].includes(row.row_type) &&
        (row.calculation?.refs?.length ?? 0) === 0);
    if (!literalHistorical) continue;
    const historical = (row.values ?? []).slice(0, 3);
    historical.forEach((value, periodIndex) => {
      if (value === null || value === undefined) return;
      const entries = provenance[row.row_id] ?? [];
      const entry = entries.find(
        (item) => Number(item.period_index) === periodIndex,
      );
      const complete =
        entry &&
        typeof entry.document === "string" &&
        entry.document.trim() &&
        typeof entry.publication_date === "string" &&
        entry.publication_date.trim() &&
        typeof entry.page_or_note === "string" &&
        entry.page_or_note.trim() &&
        typeof entry.units === "string" &&
        entry.units.trim() &&
        typeof entry.source_label === "string" &&
        entry.source_label.trim();
      if (!complete) {
        checks.push(
          result(
            `provenance.${row.row_id}.${periodIndex}`,
            "BLOCK",
            `Historical input ${row.row_id} period ${periodIndex + 1} lacks document-and-page provenance.`,
          ),
        );
      }
    });
  }
  return checks;
}

function cashBucketStatementChecks(modelCase) {
  const buckets = modelCase.cash_policy?.buckets;
  if (!Array.isArray(buckets)) return [];
  const endingCash = (modelCase.statement_structure?.cash_flow ?? []).find(
    (row) => row.semantic_role === "ending_cash" || row.row_id === "ending_cash",
  );
  if (!endingCash) return [];
  const declared = [0, 1, 2].map((index) =>
    buckets
      .filter((bucket) => bucket.included_in_cash_flow_cash !== false)
      .reduce((sum, bucket) => sum + Number(bucket.historical_year_end?.[index] ?? 0), 0),
  );
  const reported = [0, 1, 2].map((index) =>
    buckets.reduce((sum, bucket) => sum + Number(bucket.historical_year_end?.[index] ?? 0), 0),
  );
  const visible = endingCash.values?.slice(0, 3) ?? [];
  const agrees = declared.length === 3 && visible.length === 3 && declared.every(
    (value, index) => Math.abs(Number(value) - Number(visible[index])) <= 1e-8,
  );
  return [result(
    "cash_buckets.cash_flow_history_statement_tie",
    agrees ? "PASS" : "BLOCK",
    agrees
      ? "The historical cash-flow ending-cash row matches the explicit buckets included in cash-flow cash."
      : "The historical cash-flow ending-cash row must equal the sum of explicit buckets included in cash-flow cash; reported cash and liquidity remain separately defined.",
    { cash_flow_cash_history: declared, reported_cash_history: reported, ending_cash_history: visible },
  )];
}

function instrumentChecks(modelCase) {
  const checks = [];
  const instruments = modelCase.instruments ?? [];
  // A gate that inspected nothing has not passed. An empty register would
  // otherwise walk through every per-instrument check below in silence.
  if (instruments.length === 0) {
    return [
      result(
        "instrument.register_empty",
        "BLOCK",
        "The instrument register is empty, so every per-instrument check was skipped rather than passed.",
      ),
    ];
  }
  const ids = new Set();
  for (const instrument of instruments) {
    const id = instrument.instrument_id ?? "unknown";
    if (!id || ids.has(id)) {
      checks.push(
        result(
          `instrument.${id}.id`,
          "BLOCK",
          `Instrument identifiers must be present and unique: ${id}.`,
        ),
      );
    }
    ids.add(id);
    if (!instrument.name) {
      checks.push(
        result(`instrument.${id}.name`, "BLOCK", `${id} has no name.`),
      );
    }
    if (!/^[A-Z]{3}$/.test(instrument.currency ?? "")) {
      checks.push(
        result(
          `instrument.${id}.currency`,
          "BLOCK",
          `${id} has no valid three-letter currency.`,
        ),
      );
    }
    if (!finite(instrument.opening_balance) || number(instrument.opening_balance) < 0) {
      checks.push(
        result(
          `instrument.${id}.opening_balance`,
          "BLOCK",
          `${id} has no valid opening balance.`,
        ),
      );
    }
    if (
      instrument.class !== "rcf" &&
      (!instrument.maturity_date ||
        Number.isNaN(new Date(instrument.maturity_date).getTime())) &&
      instrument.maturity_treatment !== "non_maturing_within_forecast"
    ) {
      checks.push(
        result(
          `instrument.${id}.maturity`,
          "BLOCK",
          `${id} needs an explicit maturity date or a documented non_maturing_within_forecast treatment.`,
        ),
      );
    }
    if (
      instrument.class !== "rcf" &&
      instrument.maturity_treatment === "non_maturing_within_forecast" &&
      !String(instrument.assumption_note ?? "").trim()
    ) {
      // DEFECT 0.9. This branch used to call `items.push(item(...))` — neither
      // identifier exists in this scope, so the only case that could reach it
      // threw a ReferenceError out of the gate instead of emitting the BLOCK
      // it was written to emit. An instrument carried past its own maturity
      // with no stated reason is exactly the thing this check exists to stop.
      checks.push(
        result(
          `instrument.${id}.maturity_assumption`,
          "BLOCK",
          `${id} needs an assumption note for its non-maturing forecast treatment.`,
        ),
      );
    }
    if (!["fixed", "floating", "manual_all_in"].includes(instrument.rate_type)) {
      checks.push(
        result(
          `instrument.${id}.rate_type`,
          "BLOCK",
          `${id} has no valid rate type.`,
        ),
      );
    }
    if (
      instrument.rate_type === "floating" &&
      (!instrument.benchmark || !series(instrument.benchmark_rate, 3))
    ) {
      checks.push(
        result(
          `instrument.${id}.floating_rate`,
          "BLOCK",
          `${id} needs a benchmark, three forecast benchmark rates and a spread.`,
        ),
      );
    }
    if (instrument.benchmark_floor !== undefined) {
      if (instrument.rate_type !== "floating") {
        checks.push(
          result(
            `instrument.${id}.benchmark_floor_rate_type`,
            "BLOCK",
            `${id} declares a contractual benchmark floor but is not a floating-rate instrument.`,
          ),
        );
      }
      if (
        !series(instrument.benchmark_floor, 3) ||
        instrument.benchmark_floor.some((value) => !finite(value))
      ) {
        checks.push(
          result(
            `instrument.${id}.benchmark_floor`,
            "BLOCK",
            `${id} needs three numeric contractual floor rates.`,
          ),
        );
      }
    }
    if (
      instrument.pik_rate !== undefined &&
      (!series(instrument.pik_rate, 3) ||
        instrument.pik_rate.some(
          (value) => !finite(value) || number(value) < 0 || number(value) >= 2,
        ))
    ) {
      checks.push(
        result(
          `instrument.${id}.pik_rate`,
          "BLOCK",
          `${id} needs three numeric, non-negative PIK rates below 200%.`,
        ),
      );
    }
    const legacyNonCash = instrument.other_non_cash_movement;
    const componentNonCash = instrument.non_cash_movement_components;
    if (legacyNonCash !== undefined && componentNonCash !== undefined) {
      checks.push(
        result(
          `instrument.${id}.non_cash_authority`,
          "BLOCK",
          `${id} may declare the legacy aggregate or separate non-cash movement components, not both.`,
        ),
      );
    }
    if (
      legacyNonCash !== undefined &&
      (!series(legacyNonCash, 3) || legacyNonCash.some((value) => !finite(value)))
    ) {
      checks.push(
        result(
          `instrument.${id}.other_non_cash_movement`,
          "BLOCK",
          `${id} needs three numeric legacy other non-cash movements when that authority is supplied.`,
        ),
      );
    }
    if (componentNonCash !== undefined) {
      const allowedComponents = new Set(["fair_value", "other"]);
      const keys =
        componentNonCash &&
        typeof componentNonCash === "object" &&
        !Array.isArray(componentNonCash)
          ? Object.keys(componentNonCash)
          : [];
      if (
        keys.length === 0 ||
        keys.some((key) => !allowedComponents.has(key)) ||
        keys.some(
          (key) =>
            allowedComponents.has(key) &&
            (!series(componentNonCash[key], 3) ||
              componentNonCash[key].some((value) => !finite(value))),
        )
      ) {
        checks.push(
          result(
            `instrument.${id}.non_cash_movement_components`,
            "BLOCK",
            `${id} needs fair_value and/or other as separate three-value numeric non-cash series.`,
          ),
        );
      }
    }
    if (
      instrument.rate_type !== "floating" &&
      !series(instrument.coupon_or_all_in_rate, 3)
    ) {
      checks.push(
        result(
          `instrument.${id}.all_in_rate`,
          "BLOCK",
          `${id} needs three forecast coupon or all-in rates.`,
        ),
      );
    }
    if (instrument.class === "rcf") {
      if (!finite(instrument.facility_capacity)) {
        checks.push(
          result(
            `instrument.${id}.capacity`,
            "BLOCK",
            `${id} needs a facility capacity.`,
          ),
        );
      }
      if (
        !modelCase.rcf_policy ||
        !finite(modelCase.rcf_policy.commitment_fee_value) ||
        !modelCase.rcf_policy.commitment_fee_convention
      ) {
        checks.push(
          result(
            `instrument.${id}.commitment_fee`,
            "BLOCK",
            `${id} needs an explicit commitment-fee convention and value, including an explicit zero.`,
          ),
        );
      } else if (
        modelCase.rcf_policy.commitment_fee_convention !== "none" &&
        !(Number(modelCase.rcf_policy.commitment_fee_value) > 0)
      ) {
        checks.push(
          result(
            `instrument.${id}.commitment_fee_basis`,
            "BLOCK",
            `${id} declares a charged commitment-fee convention but a zero fee. Use convention "none" for a sourced no-fee facility, or supply a positive sourced fee.`,
          ),
        );
      }
    }
  }
  return checks;
}

/**
 * THE RATE A NATIVE BALANCE IS TRANSLATED AT, AND THE STATEMENT OF IT.
 *
 * DEFECT 0.10. `debt_reconciliation` used to add native USD, EUR and GBP
 * opening balances together and compare the total against a reported figure.
 * The sum of three currencies is not a currency, so the comparison was
 * meaningless — and the workbook's own gross-debt row has always been the
 * FX-TRANSLATED total, which is why the two disagreed by 463 on the maximal
 * case, 904 on AstraZeneca and 528 on Smurfit without anything firing.
 *
 * The rate is the LAST HISTORICAL PERIOD-END rate — index 2 of
 * `period_end_rates` — because the balance being translated is a balance at
 * that date. It is the same rate `solver.mjs` uses for the forecast opening
 * balance and the same cell `build_dynamic_model.mjs` points the debt schedule
 * at, so the three now agree by construction rather than by coincidence.
 */
function openingFxRate(modelCase, currency) {
  const reporting = modelCase.issuer?.reporting_currency;
  if (!currency || currency === reporting) {
    return { rate: 1, statement: `${currency ?? reporting} at par (reporting currency)` };
  }
  const pair = modelCase.fx?.[currency];
  const quoted = number(pair?.period_end_rates?.[2]);
  if (!pair || !Number.isFinite(quoted) || quoted <= 0) {
    return { rate: null, statement: null };
  }
  const rate = pair.quote === "reporting_per_native" ? quoted : 1 / quoted;
  return {
    rate,
    statement:
      `${currency}: ${quoted} ${pair.quote} at the last historical period end ` +
      `(1 ${currency} = ${rate.toPrecision(8)} ${reporting})`,
  };
}

/**
 * DEFECT 0.5 — GATE PLACEMENT, NOT A MISSING CAPABILITY.
 *
 * Multi-currency works given an `fx` entry for every non-reporting currency.
 * What did not work is what happened WITHOUT one: `fx` is a schema property
 * but not in the top-level `required` list, `coverage.mjs` never looked at it,
 * and the first thing to notice was `fxFormula` throwing
 * "Missing Forward Curves FX row for EUR" out of the middle of the emitter —
 * an uncaught stack trace where the contract promises a coverage BLOCK.
 *
 * Every currency the model will have to translate is enumerated here, and each
 * one is required to carry a complete, positive six-period pair.
 */
function fxCoverageChecks(modelCase) {
  const checks = [];
  const reporting = modelCase.issuer?.reporting_currency ?? null;
  const required = new Map();
  for (const instrument of modelCase.instruments ?? []) {
    const currency = instrument.currency;
    if (!currency || currency === reporting) continue;
    if (!required.has(currency)) required.set(currency, []);
    required.get(currency).push(instrument.instrument_id ?? "unknown");
  }
  for (const [currency, holders] of required) {
    const pair = modelCase.fx?.[currency];
    if (!pair) {
      checks.push(
        result(
          `fx.${currency}.missing`,
          "BLOCK",
          `${holders.length} instrument(s) are denominated in ${currency} but the case declares no ${currency} FX pair. ` +
            `Every non-${reporting} balance needs an fx.${currency} entry with a quote convention and six average and period-end rates, ` +
            `otherwise the model cannot state gross debt in ${reporting}.`,
          { currency, instruments: holders },
        ),
      );
      continue;
    }
    const problems = [];
    if (!["reporting_per_native", "native_per_reporting"].includes(pair.quote)) {
      problems.push("quote must be reporting_per_native or native_per_reporting");
    }
    for (const key of ["average_rates", "period_end_rates"]) {
      if (!series(pair[key], 6)) {
        problems.push(`${key} must contain six rates, one per period`);
      } else if (pair[key].some((rate) => !(number(rate) > 0))) {
        problems.push(`${key} must be strictly positive in every period`);
      }
    }
    const allDeclaredRates = [
      ...(pair.average_rates ?? []),
      ...(pair.period_end_rates ?? []),
    ].map(number);
    if (
      allDeclaredRates.length === 12 &&
      allDeclaredRates.every((rate) => rate === 1)
    ) {
      problems.push(
        "all twelve rates are the unsourced 1.0 placeholder; supply the actual historical/forecast curve",
      );
    }
    checks.push(
      result(
        `fx.${currency}`,
        problems.length === 0 ? "PASS" : "BLOCK",
        problems.length === 0
          ? `${currency} carries a complete forward FX pair for all six periods.`
          : `The ${currency} FX pair is unusable: ${problems.join("; ")}.`,
        { currency, instruments: holders, problems },
      ),
    );
  }
  // A curve is required for every floating benchmark too. Without it the
  // forecast reprices off nothing.
  const benchmarks = new Map();
  for (const instrument of modelCase.instruments ?? []) {
    if (instrument.rate_type !== "floating") continue;
    const key = instrument.benchmark ?? null;
    if (!key) continue;
    if (!benchmarks.has(key)) benchmarks.set(key, []);
    benchmarks.get(key).push(instrument.instrument_id ?? "unknown");
  }
  for (const [benchmark, holders] of benchmarks) {
    const missing = holders.filter((id) => {
      const instrument = (modelCase.instruments ?? []).find(
        (candidate) => (candidate.instrument_id ?? "unknown") === id,
      );
      return !series(instrument?.benchmark_rate, 3);
    });
    checks.push(
      result(
        `fx.curve.${benchmark}`,
        missing.length === 0 ? "PASS" : "BLOCK",
        missing.length === 0
          ? `${benchmark} carries a three-period forward curve on every instrument that reprices off it.`
          : `${benchmark} has no three-period forward curve on ${missing.join(", ")}.`,
        { benchmark, instruments: holders, missing },
      ),
    );
  }
  return checks;
}

/**
 * The reported gross-debt series, oldest first.
 *
 * DEFECT 0.4. `debt_reconciliation.reported_opening_gross_debt` is a SCALAR,
 * so the stack tied at exactly one date — the last historical year-end — while
 * `historical_supplement.prior_gross_debt_excluding_leases` wrote two further
 * reported figures straight into columns G and H as blue inputs with no gate
 * behind them at all. Either form is accepted now: a scalar still means "the
 * last historical year-end", a three-series means all three, and where both a
 * three-series and the historical supplement are present they must agree.
 */
function reportedGrossDebtSeries(modelCase) {
  const declared = modelCase.debt_reconciliation?.reported_opening_gross_debt;
  const prior = modelCase.historical_supplement?.prior_gross_debt_excluding_leases;
  if (series(declared, 3)) {
    return { values: declared.map(number), form: "series3", prior };
  }
  const scalar = number(declared);
  const priorPair = Array.isArray(prior) && prior.length === 2 ? prior.map(number) : [null, null];
  return { values: [priorPair[0], priorPair[1], scalar], form: "scalar", prior };
}

function debtReconciliationChecks(modelCase) {
  const checks = [];
  const { values: reportedSeries, form, prior } = reportedGrossDebtSeries(modelCase);
  const reported = reportedSeries[2];
  if (!Number.isFinite(reported) || reported < 0) {
    return [
      result(
        "debt_reconciliation.reported",
        "BLOCK",
        "Reported opening gross debt is required for the v2 build gate.",
      ),
    ];
  }
  // The two earlier reported year-ends are written into columns G and H by the
  // emitter. Where the case states them twice they must state the same thing.
  if (form === "series3" && Array.isArray(prior) && prior.length === 2) {
    const disagreements = [0, 1]
      .filter((index) => Math.abs(number(prior[index]) - reportedSeries[index]) > 0.01)
      .map((index) => ({
        historical_year: index + 1,
        historical_supplement: number(prior[index]),
        debt_reconciliation: reportedSeries[index],
      }));
    checks.push(
      result(
        "debt_reconciliation.historical_series_tie",
        disagreements.length === 0 ? "PASS" : "BLOCK",
        disagreements.length === 0
          ? "The reported gross-debt series agrees with the historical supplement at every earlier year-end."
          : "The reported gross-debt series and historical_supplement.prior_gross_debt_excluding_leases state different figures for the same year-end.",
        { disagreements },
      ),
    );
  }
  const instruments = modelCase.instruments ?? [];
  const untranslatable = [];
  const rateStatements = new Map();
  const translate = (instrument) => {
    const { rate, statement } = openingFxRate(modelCase, instrument.currency);
    if (rate === null) {
      untranslatable.push({
        instrument_id: instrument.instrument_id ?? "unknown",
        currency: instrument.currency ?? null,
      });
      return 0;
    }
    if (statement) rateStatements.set(instrument.currency, statement);
    return number(instrument.opening_balance || 0) * rate;
  };
  const included = instruments
    .filter(
      (item) =>
        item.include_in_gross_debt !== false &&
        item.class !== "rcf",
    )
    .reduce((sum, item) => sum + translate(item), 0);
  const rcfInstrument = instruments.find(
    (item) => item.instrument_id === modelCase.rcf_policy?.instrument_id,
  );
  const rcfRate = openingFxRate(modelCase, rcfInstrument?.currency).rate;
  const openingRcf =
    number(modelCase.rcf_policy?.opening_draw ?? 0) * (rcfRate ?? 1);
  const residualInstrument = instruments.find(
    (item) => item.is_residual_pool === true,
  );
  const actualResidual = residualInstrument ? translate(residualInstrument) : 0;
  if (untranslatable.length > 0) {
    // Reported against a figure that could not be built is not a reconciliation.
    return [
      result(
        "debt_reconciliation.untranslatable",
        "BLOCK",
        "Opening debt cannot be reconciled: one or more instruments are in a currency with no usable FX pair, so the identified total is not a currency amount.",
        { untranslatable },
      ),
    ];
  }
  const identifiedExcludingResidual = included + openingRcf - actualResidual;
  // DEFECT 0.1 — THE RESIDUAL IS SIGNED.
  //
  // `Math.max(0, reported - identified)` cannot represent the case where the
  // instruments EXCEED the reported figure. Where no residual pool is declared
  // the clamp made the gate compare 0 against 0 and return PASS, so an export
  // taken after a new issue overstated gross debt, net debt and every leverage
  // multiple below them at any magnitude with nothing firing. The clamp stays
  // on the under-identified path — a residual pool is a real, visible row and
  // it cannot be negative — but the signed figure is what is TESTED.
  const signedResidual = reported - identifiedExcludingResidual;
  const overIdentified = -signedResidual;
  const threshold = number(
    modelCase.debt_reconciliation?.maximum_residual_percentage ?? 0.05,
  );
  // An over-identification has nowhere to go: there is no negative residual
  // pool, so the permitted residual percentage does not apply to it and the
  // only tolerance is money-rounding on the translated sum.
  const moneyTolerance = Math.max(0.01, Math.abs(reported) * 1e-9);
  const requiredResidual = Math.max(0, signedResidual);
  const residualPercentage = reported === 0 ? 0 : requiredResidual / reported;
  const fxBasis = [...rateStatements.values()];
  const detail = {
    reported,
    reported_series: reportedSeries,
    identifiedExcludingResidual,
    signedResidual,
    requiredResidual,
    actualResidual,
    fx_translation: fxBasis,
    reporting_currency: modelCase.issuer?.reporting_currency ?? null,
  };
  if (overIdentified > moneyTolerance) {
    checks.push(
      result(
        "debt_reconciliation.over_identified",
        "BLOCK",
        `Identified instruments EXCEED reported gross debt by ${overIdentified.toFixed(3)} ` +
          `(${reported === 0 ? "n/a" : ((overIdentified / reported) * 100).toFixed(2)}% of the reported figure). ` +
          "A residual pool cannot absorb this — it is a visible row and it cannot be negative — so gross debt, net debt " +
          "and every leverage and coverage multiple below them are overstated. The two usual causes are: (1) the debt export " +
          "post-dates the reporting year end, so it carries an issue the reported figure does not; (2) a facility is counted " +
          "twice, once as a drawn tranche and once inside the umbrella commitment it sits under. Fix the source, do not raise the limit.",
        detail,
      ),
    );
  } else if (residualPercentage > threshold + 1e-12) {
    checks.push(
      result(
        "debt_reconciliation.residual_limit",
        "BLOCK",
        `Unidentified debt is ${(residualPercentage * 100).toFixed(2)}% of reported gross debt, above the ${(threshold * 100).toFixed(2)}% limit.`,
        detail,
      ),
    );
  } else if (Math.abs(actualResidual - requiredResidual) > 0.01) {
    checks.push(
      result(
        "debt_reconciliation.residual_tie",
        "BLOCK",
        "The visible residual debt pool does not reconcile identified instruments to reported gross debt.",
        detail,
      ),
    );
  } else {
    checks.push(
      result(
        "debt_reconciliation",
        "PASS",
        `Opening debt reconciles after the permitted visible residual pool` +
          `${fxBasis.length ? `, translated at ${fxBasis.join("; ")}` : ""}.`,
        { ...detail, residualPercentage },
      ),
    );
  }
  // The per-year residual, stated on the face of the reconciliation. Years one
  // and two carry no instrument-level history, so their identified figure IS
  // the reported hardcode the emitter writes into columns G and H; saying so
  // is the point — the reader can see which years are tied and which are
  // asserted, instead of one tie standing in for three.
  for (let index = 0; index < 3; index += 1) {
    const yearReported = reportedSeries[index];
    if (!Number.isFinite(yearReported)) {
      checks.push(
        result(
          `debt_reconciliation.year_${index + 1}`,
          "BLOCK",
          `Historical year ${index + 1} has no reported gross-debt figure; column ${["G", "H", "I"][index]} of the debt schedule would be blank.`,
        ),
      );
      continue;
    }
    const tied = index === 2;
    checks.push(
      result(
        `debt_reconciliation.year_${index + 1}`,
        "PASS",
        tied
          ? `Historical year 3 reported gross debt ${yearReported} is tied to the instrument register; residual ${signedResidual.toFixed(3)}.`
          : `Historical year ${index + 1} reported gross debt ${yearReported} is a stated actual with no instrument-level history behind it; residual 0 by construction.`,
        {
          period_index: index,
          reported: yearReported,
          identification_basis: tied ? "instrument_register" : "reported_hardcode",
          residual: tied ? signedResidual : 0,
        },
      ),
    );
  }
  return checks;
}

function historicalInterestChecks(modelCase) {
  const reported = modelCase.historical_interest_reconciliation?.reported_interest;
  const identified =
    modelCase.historical_interest_reconciliation?.identified_interest;
  if (reported === undefined && identified === undefined) return [];
  if (!series(reported, 3) || !series(identified, 3)) {
    return [
      result(
        "historical_interest.shape",
        "BLOCK",
        "Historical interest reconciliation needs three reported and three identified values.",
      ),
    ];
  }
  const limit = number(
    modelCase.historical_interest_reconciliation?.maximum_plug_percentage ??
      0.1,
  );
  const checks = [];
  for (let index = 0; index < 3; index += 1) {
    const reportedAbs = Math.abs(number(reported[index]));
    const plug = number(reported[index]) - number(identified[index]);
    const percentage =
      reportedAbs === 0 ? (Math.abs(plug) <= 0.01 ? 0 : Infinity) : Math.abs(plug) / reportedAbs;
    checks.push(
      result(
        `historical_interest.${index}`,
        percentage > limit + 1e-12 ? "BLOCK" : "PASS",
        percentage > limit + 1e-12
          ? `Historical interest plug in period ${index + 1} is above the ${(limit * 100).toFixed(1)}% limit.`
          : `Historical interest period ${index + 1} is within the plug limit.`,
        { reported: number(reported[index]), identified: number(identified[index]), plug, percentage },
      ),
    );
  }
  return checks;
}

function brokerChecks(modelCase) {
  const pack = modelCase.broker_pack;
  if (!pack) {
    return [
      result(
        "broker_pack",
        "BLOCK",
        "A broker pack is required for the v2 production workflow.",
      ),
    ];
  }
  const checks = [];
  const requiredMetrics = [
    "revenue",
    "depreciation_and_amortisation",
    "effective_tax_rate",
    "capex",
    "change_in_working_capital",
    "dividends",
  ];
  for (const metricId of requiredMetrics) {
    const metric = pack.metrics?.[metricId];
    const optional =
      metricId === "dividends" &&
      modelCase.coverage_policy?.dividends_not_relevant === true;
    if (!metric && !optional) {
      checks.push(
        result(
          `broker_pack.${metricId}`,
          "BLOCK",
          `Broker pack is missing required metric ${metricId}.`,
        ),
      );
    }
  }
  const populatedBrokerPeriods = (metricId) => {
    const metric = pack.metrics?.[metricId] ?? {};
    const candidates = [
      ...(metric.provider_consensus ? [metric.provider_consensus] : []),
      ...Object.values(metric.brokers ?? {}),
    ];
    return Math.max(
      0,
      ...candidates.map(
        (values) =>
          (values ?? []).filter(
            (value) => value !== null && value !== undefined && finite(value),
          ).length,
      ),
    );
  };
  const anchorCoverage = ["ebit", "adjusted_ebitda"].map((metricId) => ({
    metricId,
    populated: populatedBrokerPeriods(metricId),
  }));

  // A model does not have to be EBIT- or EBITDA-led.  Prove an alternative
  // forecast authority by walking the issuer's declared formula graph.  The
  // only implicit leaves are quantities solved by the debt engine itself;
  // every other leaf must be a populated broker series or an explicit
  // hardcode/zero.  This admits PBT-led and net-income-led cases without
  // weakening the gate for a case that simply omitted operating forecasts.
  const rows = normaliseStatementRows(modelCase, "income_statement");
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const rowForRole = (role) => rows.find((row) => row.semantic_role === role);
  const solvedRoles = new Set(["interest_income", "interest_expense"]);
  const visiting = new Set();
  const authorities = new Set();
  const resolvable = (rowId) => {
    const row = byId.get(rowId);
    if (!row) return false;
    if (solvedRoles.has(row.semantic_role)) return true;
    if (visiting.has(rowId)) return false;
    if (row.broker_metric_id && populatedBrokerPeriods(row.broker_metric_id) === 3) {
      authorities.add(row.broker_metric_id);
      return true;
    }
    if (row.forecast_treatment === "zero") return true;
    if (row.forecast_treatment === "hardcode") {
      return (row.values ?? []).slice(3, 6).every(
        (value) => value !== null && value !== undefined && finite(value),
      );
    }
    const rule = row.forecast_calculation ??
      (!["broker", "hardcode", "zero", "uncalculated"].includes(row.forecast_treatment)
        ? row.calculation
        : null);
    if (!rule || !Array.isArray(rule.refs) || rule.refs.length === 0) return false;
    visiting.add(rowId);
    const pass = rule.refs.every((ref) => resolvable(ref));
    visiting.delete(rowId);
    return pass;
  };
  const declaredAuthorityPass = ["ebit", "adjusted_ebitda"].every((role) => {
    const row = rowForRole(role);
    return Boolean(row && resolvable(row.row_id));
  });
  anchorCoverage.sort(
    (left, right) =>
      right.populated - left.populated ||
      (left.metricId === "ebit" ? -1 : 1),
  );
  checks.push(
    result(
      "broker_pack.forecast_anchor",
      anchorCoverage[0].populated === 0 && !declaredAuthorityPass
        ? "BLOCK"
        : "PASS",
      anchorCoverage[0].populated > 0
        ? `${anchorCoverage[0].metricId} selected as the operating forecast anchor.`
        : declaredAuthorityPass
          ? `Declared statement graph resolves EBIT and EBITDA from ${[...authorities].join(", ")}.`
          : "Neither EBIT/EBITDA nor a complete declared alternative authority path has usable broker coverage.",
      {
        coverage: anchorCoverage,
        declared_statement_authority: {
          pass: declaredAuthorityPass,
          broker_metrics: [...authorities].sort(),
        },
      },
    ),
  );
  return checks;
}

function acquisitionChecks(modelCase) {
  if (!modelCase.modules?.acquisition) return [];
  const acquisition = modelCase.acquisition;
  // The acquisition case declares the transaction and nothing else. Its
  // operating profile — growth, margin, D&A, tax, capex, working capital — is
  // derived from the standalone case in the adjustment columns, so those are
  // no longer inputs and are no longer required here.
  const required = [
    "enabled",
    "transaction_enterprise_value",
    "entry_ev_to_ebitda",
    "acquisition_debt_amount",
    "incremental_rate",
    "close_year",
    "close_month",
  ];
  const checks = required
    .filter((key) => acquisition?.[key] === undefined)
    .map((key) =>
      result(
        `acquisition.${key}`,
        "BLOCK",
        `Acquisition input ${key} is required.`,
      ),
    );
  if (checks.length > 0) return checks;
  for (const key of PRODUCTION_CONTRACT.acquisition.positive_input_fields) {
    if (!finite(acquisition[key]) || number(acquisition[key]) <= 0) {
      checks.push(
        result(
          `acquisition.${key}.illustrative_value`,
          "BLOCK",
          `Acquisition input ${key} must contain a positive illustrative value.`,
        ),
      );
    }
  }
  const forecastYears = new Set(
    (modelCase.periods ?? [])
      .slice(3)
      .map((period) => new Date(period.date).getUTCFullYear()),
  );
  if (
    PRODUCTION_CONTRACT.acquisition.close_year_must_be_forecast &&
    !forecastYears.has(Number(acquisition.close_year))
  ) {
    checks.push(
      result(
        "acquisition.close_year.forecast",
        "BLOCK",
        "The illustrative acquisition close year must be one of the three forecast years.",
        { close_year: acquisition.close_year, forecast_years: [...forecastYears] },
      ),
    );
  }
  return checks;
}

export function assessCoverage(modelCase) {
  const checks = [];
  if (Number(modelCase.contract_version) !== 2) {
    checks.push(
      result(
        "contract_version",
        "BLOCK",
        "Dynamic production builds require contract_version 2.",
      ),
    );
  }
  const periods = modelCase.periods ?? [];
  if (
    periods.length !== 6 ||
    periods.slice(0, 3).some((item) => item.status !== "historical") ||
    periods.slice(3).some((item) => item.status !== "forecast")
  ) {
    checks.push(
      result(
        "periods",
        "BLOCK",
        "The model must contain exactly three historical and three forecast periods.",
      ),
    );
  }
  checks.push(...statementCoverageChecks(modelCase));
  checks.push(...requiredRoleChecks(modelCase));
  checks.push(...dependencyChecks(modelCase));
  checks.push(...statementHierarchyChecks(modelCase));
  checks.push(...historicalProvenanceChecks(modelCase));
  checks.push(...cashBucketStatementChecks(modelCase));
  checks.push(...instrumentChecks(modelCase));
  checks.push(...fxCoverageChecks(modelCase));
  checks.push(...debtReconciliationChecks(modelCase));
  checks.push(...historicalInterestChecks(modelCase));
  checks.push(...brokerChecks(modelCase));
  checks.push(...acquisitionChecks(modelCase));
  const blockers = checks.filter((item) => item.status === "BLOCK");
  return {
    schema_version: 1,
    case_id: modelCase.case_id ?? null,
    ready_to_build: blockers.length === 0,
    selected_forecast_anchor: (() => {
      const detail = checks.find(
        (item) => item.id === "broker_pack.forecast_anchor",
      )?.detail;
      if (
        detail?.coverage?.[0]?.populated === 0 &&
        detail?.declared_statement_authority?.pass
      ) {
        return detail.declared_statement_authority.broker_metrics.join("+");
      }
      return detail?.coverage?.[0]?.metricId ?? null;
    })(),
    summary: {
      pass: checks.filter((item) => item.status === "PASS").length,
      warnings: checks.filter((item) => item.status === "WARN").length,
      blockers: blockers.length,
    },
    checks,
  };
}
