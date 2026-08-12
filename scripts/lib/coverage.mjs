import fs from "node:fs";
import { compiledCashFlowRoles, normaliseStatementRows } from "./row_plan.mjs";
import { classifyStatementLine, isHighImpactRole } from "./statement_classifier.mjs";
import { validateForecastAuthorities } from "./forecast_authority.mjs";
import { compileStatementTopology } from "./statement_topology.mjs";
import { resolveAnchorPlanDecision } from "./broker_anchor.mjs";
import { coreConsumptionIds } from "./broker_metric_dictionary.mjs";
import { resolveHistoricalInterestAuthority } from "./historical_interest_authority.mjs";
import { compileOpeningInstrumentState } from "./instrument_period_state.mjs";
import { isBalancingRcf } from "./rcf_policy.mjs";

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

function statementTopologyChecks(modelCase) {
  const checks = [];
  for (const section of ["income_statement", "cash_flow"]) {
    const rows = normaliseStatementRows(modelCase, section);
    const topology = compileStatementTopology(modelCase, section, rows);
    checks.push(
      result(
        `statement_topology.${section}`,
        topology.errors.length === 0 ? "PASS" : "BLOCK",
        topology.errors.length === 0
          ? `${section} visible rows preserve the compiled source and hierarchy graph.`
          : `${section} has ${topology.errors.length} visible ordering, ownership or hierarchy violation(s).`,
        topology,
      ),
    );
  }
  return checks;
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
      if (disclosure.projection_lineage) {
        const lineage = disclosure.projection_lineage;
        const sameMembers = (left, right) =>
          left.length === right.length &&
          left.every((value) => right.includes(value));
        const projectedRows = (lineage.projected_row_ids ?? [])
          .map((rowId) => allRows.find((row) => row.row_id === rowId))
          .filter(Boolean);
        const originalIncludesAbsorbed = (lineage.absorbed_row_ids ?? []).every(
          (rowId) => (lineage.source_mapped_row_ids ?? []).includes(rowId),
        );
        const absorbedAreNotVisible = (lineage.absorbed_row_ids ?? []).every(
          (rowId) => !rowIds.has(rowId),
        );
        const everyAbsorptionProved = (lineage.absorbed_row_ids ?? []).every(
          (absorbedId) => projectedRows.some(
            (row) =>
              (row.projection_absorbed_row_ids ?? []).includes(absorbedId) &&
              (row.source_line_ids ?? []).includes(disclosure.source_line_id),
          ),
        );
        const valid =
          lineage.compiler_version === "semantic-statements/1.0" &&
          lineage.rule === "semantic_dependency_projection" &&
          sameMembers(mappedIds, lineage.projected_row_ids ?? []) &&
          projectedRows.length === (lineage.projected_row_ids ?? []).length &&
          originalIncludesAbsorbed &&
          absorbedAreNotVisible &&
          everyAbsorptionProved;
        checks.push(
          result(
            `source_coverage.${id}.projection_lineage`,
            valid ? "PASS" : "BLOCK",
            valid
              ? `${disclosure.label ?? id} preserves its original destination through an explicit semantic projection lineage.`
              : `${disclosure.label ?? id} has an incomplete or inconsistent semantic projection lineage.`,
            lineage,
          ),
        );
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
    !calculation || [
      "prior_period",
      "historical_average",
      "historical_trend",
    ].includes(calculation.operator)
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
  // Accounting basis is required where classification depends on operating
  // scope or accounting taxonomy. A mechanically derived financing family
  // (for example Change in Debt over schedule-linked movements) needs an
  // exact parent/child contract, but IFRS-versus-GAAP is not evidence for that
  // arithmetic and must not become a spurious intake blocker.
  const accountingBasisSensitiveClasses = new Set([
    "working_capital",
    "provision",
    "pension",
    "tax",
    "restructuring",
    "deferred_revenue",
    "other_operating",
  ]);
  const accountingBasisRequired = suppliedRows.some(
    (row) =>
      row.operation_scope ||
      accountingBasisSensitiveClasses.has(row.economic_class),
  );
  if (accountingBasisRequired && !modelCase.issuer?.accounting_basis) {
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

export function statementAuthorityChecks(modelCase) {
  const checks = [];
  const productionEvidence =
    modelCase.execution_profile !== "reference_parity" &&
    modelCase.source_coverage?.classification_contract_version === "evidence_v1";
  if (!productionEvidence) return checks;
  if (modelCase.statement_authority_contract_version !== "authority_v1") {
    return [
      result(
        "statement_authority.contract_version",
        "BLOCK",
        "Production evidence requires statement_authority_contract_version=authority_v1.",
      ),
    ];
  }
  const scheduleRoles = new Set([
    "interest_income",
    "interest_expense",
    "cash_interest_paid",
    "cash_interest_received",
    "debt_issuance",
    "debt_repayment",
    "rcf_draw",
    "rcf_repayment",
    "lease_principal",
    // Computed by the solver from the debt schedule (PIK, fee amortisation),
    // never from filed history.
    "non_cash_interest_addback",
  ]);
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase.statement_structure?.[section] ?? []) {
      if (row.row_type === "header") continue;
      const id = `statement_authority.${section}.${row.row_id}`;
      const authority = row.historical_authority;
      if (!authority) {
        checks.push(
          result(
            `${id}.missing`,
            "BLOCK",
            `${row.label} has no declared historical authority.`,
          ),
        );
        continue;
      }
      const historicalValues = (row.values ?? []).slice(0, 3);
      const hasThreeValues =
        historicalValues.length === 3 &&
        historicalValues.every(
          (value) => value !== null && value !== undefined && finite(value),
        );
      const refs = row.calculation?.refs ?? [];
      if (authority === "source_input" && !hasThreeValues) {
        checks.push(
          result(
            `${id}.source_input`,
            "BLOCK",
            `${row.label} declares source_input but does not carry three filed historical values.`,
          ),
        );
      }
      if (
        authority === "source_input" &&
        refs.length > 0 &&
        row.aggregation_authority !== "reported_parent"
      ) {
        checks.push(
          result(
            `${id}.unresolved_arithmetic_parent`,
            "BLOCK",
            `${row.label} is a sourced total with visible arithmetic dependencies but is neither an exact reconciled formula nor a declared reported parent.`,
          ),
        );
      }
      if (authority === "derived_formula" && refs.length === 0) {
        checks.push(
          result(
            `${id}.derived_formula`,
            "BLOCK",
            `${row.label} declares derived_formula without visible dependencies.`,
          ),
        );
      }
      if (authority === "reported_total_reconciled") {
        if (refs.length === 0) {
          checks.push(
            result(
              `${id}.reported_formula`,
              "BLOCK",
              `${row.label} is a reported total but has no visible reconciliation formula.`,
            ),
          );
        }
        if (
          !series(row.reported_historical_values, 3) ||
          row.reported_historical_values.some((value) => value === null)
        ) {
          checks.push(
            result(
              `${id}.reported_values`,
              "BLOCK",
              `${row.label} does not retain all three filed totals for reconciliation.`,
            ),
          );
        }
        if (hasThreeValues) {
          checks.push(
            result(
              `${id}.duplicate_input`,
              "BLOCK",
              `${row.label} duplicates a derived total in values; emitted historical cells must remain formulas.`,
            ),
          );
        }
      }
      if (authority === "schedule_link" && !scheduleRoles.has(row.semantic_role)) {
        checks.push(
          result(
            `${id}.schedule_role`,
            "BLOCK",
            `${row.label} declares schedule_link without a schedule-owned semantic role.`,
          ),
        );
      }
      if (authority === "not_applicable" && row.row_type !== "uncalculated") {
        checks.push(
          result(
            `${id}.not_applicable`,
            "BLOCK",
            `${row.label} declares no historical authority but is not intentionally uncalculated.`,
          ),
        );
      }
    }
  }
  return checks;
}

// THE CASE-LEVEL CHOKE POINT FOR BROKER CONSUMPTION. The pack compiler
// enforces the tiers on what a pack may CARRY; this check enforces them on
// what the model may WIRE. A statement row consuming a broker metric outside
// the fixed Tier-1 core must point at a recorded flex election - otherwise
// the run that projected hundreds of broker line items into the workbook
// would still be reachable through a hand-authored case, whatever the pack
// said. Aggregate working capital is deliberately Tier 1 while its
// components are not: a row consuming a component-level broker series when
// the aggregate exists is exactly the granularity the doctrine forbids.
// Derived, never restated: assets/broker-metric-dictionary.json is the single
// source for what "Tier 1" means, and the loader refuses on digest drift or an
// internally inconsistent asset. The list used to be written out here, in the
// pack compiler and in the renderer - three copies of one rule, agreeing only
// by memory.
function brokerConsumptionTierChecks(modelCase) {
  const checks = [];
  const tier1 = coreConsumptionIds();
  const elections = new Set(
    (modelCase.broker_pack?.flex_elections ?? []).map((item) => item.metric_id),
  );
  const packMetrics = modelCase.broker_pack?.metrics ?? {};
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase.statement_structure?.[section] ?? []) {
      const metricId = row.broker_metric_id;
      if (!metricId) continue;
      if (tier1.has(metricId) || elections.has(metricId)) continue;
      // A metric the pack does not even carry is caught by the existing
      // pack-shape checks; this one is specifically about tier discipline.
      if (packMetrics[metricId] === undefined && Object.keys(packMetrics).length === 0) continue;
      checks.push(
        result(
          `broker_tier.${section}.${row.row_id}`,
          "BLOCK",
          `Row ${row.row_id} consumes broker metric ${metricId}, which is neither Tier-1 core nor a recorded flex election. Unconsumed broker detail stays evidence; record an election or remove the wiring.`,
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

function forecastAuthorityChecks(modelCase) {
  if (
    modelCase.source_coverage?.classification_contract_version === "evidence_v1" &&
    modelCase.execution_profile !== "reference_parity" &&
    modelCase.forecast_authority_contract_version !== "waterfall_v1"
  ) {
    return [
      result(
        "forecast_authority.contract_version",
        "BLOCK",
        "Production evidence requires forecast_authority_contract_version=waterfall_v1; legacy implicit zeros and undeclared grey rows are not permitted.",
      ),
    ];
  }
  const rows = allStatementRows(modelCase);
  const errors = validateForecastAuthorities(modelCase, rows);
  if (errors.length > 0) {
    return errors.map((message, index) =>
      result(
        `forecast_authority.${index + 1}`,
        "BLOCK",
        message,
      ),
    );
  }
  return [
    result(
      "forecast_authority.period_waterfall",
      "PASS",
      modelCase.forecast_authority_contract_version === "waterfall_v1"
        ? "Every independent forecast input resolves through the per-row, per-period waterfall; formula, schedule, zero and intentionally uncalculated states remain distinct."
        : "The legacy forecast declarations resolve without an unresolved path; waterfall-v1 strict hardcode provenance is not asserted for this archived case.",
    ),
  ];
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
  const displayNames = new Set();
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
    } else {
      const normalisedName = String(instrument.name).trim().toLowerCase();
      if (displayNames.has(normalisedName)) {
        checks.push(
          result(
            `instrument.${id}.duplicate_display_name`,
            "BLOCK",
            `${instrument.name} is not a unique audit label; each instrument must retain enough coupon, maturity or facility identity to be distinguished on both debt and interest schedules.`,
          ),
        );
      }
      displayNames.add(normalisedName);
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
    if (
      modelCase.execution_profile !== "reference_parity" &&
      modelCase.source_coverage?.classification_contract_version === "evidence_v1" &&
      !["native_principal", "reporting_currency_carrying_value"].includes(
        instrument.balance_basis,
      )
    ) {
      checks.push(
        result(
          `instrument.${id}.balance_basis`,
          "BLOCK",
          `${id} must declare whether supplied debt values are native principal or reporting-currency carrying values.`,
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
    if (!["fixed", "floating", "manual_all_in", "unpriced"].includes(instrument.rate_type)) {
      checks.push(
        result(
          `instrument.${id}.rate_type`,
          "BLOCK",
          `${id} has no valid rate type.`,
        ),
      );
    }
    if (
      instrument.rate_type === "unpriced" &&
      (instrument.pricing_treatment !== "residual_interest_plug" ||
        !String(instrument.pricing_treatment_reason ?? "").trim())
    ) {
      checks.push(
        result(
          `instrument.${id}.pricing_treatment`,
          "BLOCK",
          `${id} is unpriced but lacks the visible residual-interest-plug treatment and reason.`,
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
      ["fixed", "manual_all_in"].includes(instrument.rate_type) &&
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
    // Rate-band plausibility. Rates are decimals (0.04 = 4.0%), and the
    // commonest ingestion defect is a percent value divided by 100 a second
    // time: a 0.700% coupon arriving as 0.00007 prices a bond's interest at
    // zero while every parity gate still agrees. A coupon or spread strictly
    // between zero and five basis points, or above 25%, is mis-scaled until
    // the evidence says otherwise; an exact zero remains a legal zero-coupon.
    {
      const couponValues = (Array.isArray(instrument.coupon_or_all_in_rate)
        ? instrument.coupon_or_all_in_rate
        : []
      ).map(Number);
      const misScaled = couponValues.filter(
        (value) =>
          Number.isFinite(value) &&
          ((value > 0 && value < 0.0005) || value > 0.25),
      );
      if (misScaled.length > 0) {
        checks.push(
          result(
            `instrument.${id}.rate_band`,
            "BLOCK",
            `${id} carries a coupon or all-in rate of ${misScaled[0]} — below ` +
              "five basis points or above 25% as a decimal. Rates are " +
              "decimals (0.04 = 4.0%); a value this size is a percent divided " +
              "by 100 twice (or not at all) until the source evidence " +
              "explicitly says otherwise.",
          ),
        );
      }
      const spreadBps = Number(instrument.spread_bps);
      if (
        Number.isFinite(spreadBps) &&
        ((spreadBps > 0 && spreadBps < 5) || spreadBps > 2500)
      ) {
        checks.push(
          result(
            `instrument.${id}.spread_band`,
            "BLOCK",
            `${id} declares a floating spread of ${spreadBps}bps — below five ` +
              "basis points or above 2,500. spread_bps is an integer in basis " +
              "points; a value this size is a decimal fraction or a percent " +
              "that slipped into a bps field.",
          ),
        );
      }
    }
    if (instrument.class === "rcf") {
      const balancing = isBalancingRcf(modelCase, instrument);
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
        balancing &&
        (!modelCase.rcf_policy ||
          !finite(modelCase.rcf_policy.commitment_fee_value) ||
          !modelCase.rcf_policy.commitment_fee_convention)
      ) {
        checks.push(
          result(
            `instrument.${id}.commitment_fee`,
            "BLOCK",
            `${id} needs an explicit commitment-fee convention and value, including an explicit zero.`,
          ),
        );
      } else if (
        balancing &&
        modelCase.rcf_policy.commitment_fee_convention === "bps_on_undrawn" &&
        !(Number(modelCase.rcf_policy.commitment_fee_value) > 0)
      ) {
        checks.push(
          result(
            `instrument.${id}.commitment_fee_basis`,
            "BLOCK",
            `${id} declares a charged commitment-fee convention but a zero fee. Use convention "none" for a sourced no-fee facility, or supply a positive sourced fee.`,
          ),
        );
      } else if (
        balancing &&
        modelCase.rcf_policy.commitment_fee_convention === "captured_in_residual" &&
        instrument.rate_type !== "unpriced"
      ) {
        checks.push(
          result(
            `instrument.${id}.commitment_fee_residual_basis`,
            "BLOCK",
            `${id} may capture its commitment fee in the residual bridge only when the facility is explicitly unpriced.`,
          ),
        );
      }
    }
  }
  return checks;
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
    if (instrument.balance_basis === "reporting_currency_carrying_value") continue;
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
  const openingState = compileOpeningInstrumentState(modelCase);
  if (openingState.status !== "PASS") {
    // Reported against a figure that could not be built is not a reconciliation.
    return [
      result(
        "debt_reconciliation.untranslatable",
        "BLOCK",
        "Opening debt cannot be reconciled: one or more instruments are in a currency with no usable FX pair, so the identified total is not a currency amount.",
        { errors: openingState.errors, opening_instrument_state: openingState },
      ),
    ];
  }
  const includedRows = openingState.rows.filter(
    (row) => row.include_in_gross_debt,
  );
  const residualRows = includedRows.filter((row) => row.is_residual_pool);
  const actualResidual = residualRows.reduce(
    (total, row) => total + row.reporting_amount,
    0,
  );
  const identifiedExcludingResidual = includedRows.reduce(
    (total, row) =>
      total + (row.is_residual_pool ? 0 : row.reporting_amount),
    0,
  );
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
  const fxBasis = [...new Map(
    openingState.rows.map((row) => [
      `${row.basis_currency}\u0000${row.translation_rate}`,
      row.translation_method === "native_principal_to_reporting"
        ? `${row.basis_currency}: 1 ${row.basis_currency} = ${row.translation_rate.toPrecision(8)} ${openingState.reporting_currency} at ${openingState.as_of}`
        : `${row.basis_currency}: no translation (${row.balance_basis})`,
    ]),
  ).values()];
  const detail = {
    reported,
    reported_series: reportedSeries,
    identifiedExcludingResidual,
    signedResidual,
    requiredResidual,
    actualResidual,
    fx_translation: fxBasis,
    reporting_currency: modelCase.issuer?.reporting_currency ?? null,
    opening_instrument_state: openingState,
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
  const authority = resolveHistoricalInterestAuthority(modelCase);
  if (!authority.present) return [];
  if (!authority.valid) {
    return [
      result(
        "historical_interest.shape",
        "BLOCK",
        authority.errors.join(" "),
        { basis: authority.basis, errors: authority.errors },
      ),
    ];
  }
  const limit = number(
    modelCase.historical_interest_reconciliation?.maximum_plug_percentage ??
      0.1,
  );
  const checks = [];
  checks.push(
    result(
      "historical_interest.basis",
      "PASS",
      authority.has_filed_total
        ? `Historical interest uses ${authority.basis}; lease interest is canonicalised exactly once before the residual is tested.`
        : "Historical interest uses identified_components_only; no filed total or unallocated residual is asserted.",
      {
        basis: authority.basis,
        basis_was_explicit: authority.basis_was_explicit,
        has_filed_total: authority.has_filed_total,
      },
    ),
  );
  for (let index = 0; index < 3; index += 1) {
    if (!authority.has_filed_total) {
      checks.push(
        result(
          `historical_interest.${index}`,
          "PASS",
          `Historical interest period ${index + 1} is component-only; the visible schedule has no asserted filed-total residual.`,
          {
            basis: authority.basis,
            identified:
              authority.identified_finance_components[index],
            lease_interest: authority.lease_interest[index],
          },
        ),
      );
      continue;
    }
    const reportedAbs = Math.abs(
      number(authority.filed_finance_expense[index]),
    );
    const plug = number(authority.unallocated_interest[index]);
    const percentage =
      reportedAbs === 0 ? (Math.abs(plug) <= 0.01 ? 0 : Infinity) : Math.abs(plug) / reportedAbs;
    checks.push(
      result(
        `historical_interest.${index}`,
        percentage > limit + 1e-12 ? "BLOCK" : "PASS",
        percentage > limit + 1e-12
          ? `Historical interest plug in period ${index + 1} is above the ${(limit * 100).toFixed(1)}% limit.`
          : `Historical interest period ${index + 1} is within the plug limit.`,
        {
          basis: authority.basis,
          filed_finance_expense: number(
            authority.filed_finance_expense[index],
          ),
          reported_debt_interest: number(
            authority.reported_debt_interest[index],
          ),
          identified_finance_components: number(
            authority.identified_finance_components[index],
          ),
          lease_interest: number(authority.lease_interest[index]),
          plug,
          percentage,
        },
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

  const compiledBrokerRows = [
    ...rows,
    ...normaliseStatementRows(modelCase, "cash_flow"),
  ];
  const consumedMetricIds = new Set(
    compiledBrokerRows
      .map((row) => row.broker_metric_id)
      .filter(Boolean),
  );
  for (const [metricId, metric] of Object.entries(pack.metrics ?? {})) {
    if (consumedMetricIds.has(metricId)) continue;
    const disposition = metric.model_disposition;
    const reason = metric.model_disposition_reason;
    const explicitlyExcluded =
      ["reference_only", "rejected", "not_applicable"].includes(disposition) &&
      typeof reason === "string" &&
      reason.trim().length > 0;
    // A disclosed broker subtotal may deliberately remain a counter-headline
    // rather than drive the model when the compiled statement calculates the
    // same semantic concept from visible constituents.  This is generic: it
    // covers revenue, working capital, capex, EBIT/EBITDA and any future
    // issuer-specific subtotal without teaching the renderer issuer labels or
    // row numbers.  It is not an orphan exemption—the semantic row must exist
    // and must carry a declared calculation graph.
    const derivedSemanticReference = compiledBrokerRows.some((row) => {
      if (row.semantic_role !== metricId) return false;
      const rule = row.forecast_calculation ?? row.calculation;
      return (
        row.forecast_treatment === "formula" ||
        row.historical_authority === "derived_formula" ||
        Boolean(rule && Array.isArray(rule.refs) && rule.refs.length > 0)
      );
    });
    checks.push(
      result(
        `broker_pack.${metricId}.consumption`,
        explicitlyExcluded || derivedSemanticReference ? "PASS" : "BLOCK",
        explicitlyExcluded
          ? `${metricId} is explicitly ${disposition}: ${reason.trim()}`
          : derivedSemanticReference
            ? `${metricId} is retained on Brokers as a disclosed counter-headline while the visible model derives the same semantic concept through its declared calculation graph.`
          : `${metricId} is present in the accepted broker pack but maps to no visible statement or schedule node. Map it exactly once or reject it with a model disposition and reason.`,
      ),
    );
  }
  return checks;
}

function brokerAnchorResolutionChecks(modelCase) {
  const decision = resolveAnchorPlanDecision(
    modelCase,
    modelCase.statement_structure?.income_statement ?? [],
  );
  return [
    result(
      "broker_pack.anchor_resolution",
      decision.status === "unresolved" ? "BLOCK" : "PASS",
      decision.status === "applied"
        ? `Broker anchor resolves through ${decision.selection.headline_anchor} plus D&A.`
        : decision.status === "not_applicable"
          ? "The statement declares an alternative forecast authority; the EBIT/EBITDA broker-anchor rule is not applicable."
          : `Broker anchor is unresolved: ${decision.reason}`,
      {
        status: decision.status,
        reason: decision.reason ?? null,
        headline_anchor: decision.selection?.headline_anchor ?? null,
        definition_compatibility:
          decision.selection?.definition_compatibility ?? null,
      },
    ),
  ];
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
  const closeDate = new Date(
    Date.UTC(
      Number(acquisition.close_year),
      Number(acquisition.close_month) - 1,
      1,
    ),
  );
  const periods = modelCase.periods ?? [];
  const closeFallsInForecast = periods.slice(3).some((period, offset) => {
    const periodIndex = offset + 3;
    const periodEnd = new Date(period.date);
    const priorEnd = new Date(periods[periodIndex - 1]?.date);
    const periodStart = new Date(priorEnd.getTime() + 86400000);
    return closeDate >= periodStart && closeDate <= periodEnd;
  });
  if (
    PRODUCTION_CONTRACT.acquisition.close_year_must_be_forecast &&
    !closeFallsInForecast
  ) {
    checks.push(
      result(
        "acquisition.close_year.forecast",
        "BLOCK",
        "The acquisition close date must fall inside one of the three actual forecast-period boundaries.",
        {
          close_date: closeDate.toISOString().slice(0, 10),
          forecast_periods: periods.slice(3).map((period, offset) => ({
            start: new Date(
              new Date(periods[offset + 2].date).getTime() + 86400000,
            ).toISOString().slice(0, 10),
            end: period.date,
          })),
        },
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
  checks.push(...statementAuthorityChecks(modelCase));
  checks.push(...statementHierarchyChecks(modelCase));
  checks.push(...statementTopologyChecks(modelCase));
  checks.push(...historicalProvenanceChecks(modelCase));
  checks.push(...brokerConsumptionTierChecks(modelCase));
  checks.push(...forecastAuthorityChecks(modelCase));
  checks.push(...cashBucketStatementChecks(modelCase));
  checks.push(...instrumentChecks(modelCase));
  checks.push(...fxCoverageChecks(modelCase));
  checks.push(...debtReconciliationChecks(modelCase));
  checks.push(...historicalInterestChecks(modelCase));
  checks.push(...brokerChecks(modelCase));
  checks.push(...brokerAnchorResolutionChecks(modelCase));
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
