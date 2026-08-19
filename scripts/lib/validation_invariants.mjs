import crypto from "node:crypto";
import { validateInstrumentPeriodStateArtifact } from "./instrument_period_state.mjs";
import { validateLayeredGraphConstitution } from "./layered_graph_constitution.mjs";
import { hasBalancingRcf } from "./rcf_policy.mjs";

const APPROVED_MAPPING_METHODS = new Set([
  "exact",
  "renamed",
  "aggregate",
  "split",
  "derived",
  "not_applicable",
]);

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

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : String(value))
    .digest("hex");
}

export function buildNativeEvidenceBindings({
  caseId,
  caseSha256,
  workbookBytes,
  semanticManifestBytes,
  rowMapBytes,
}) {
  return {
    case_id: caseId,
    case_sha256: caseSha256,
    workbook_sha256: sha256(workbookBytes),
    semantic_manifest_sha256: sha256(semanticManifestBytes),
    row_map_sha256: sha256(rowMapBytes),
  };
}

export function deterministicCaseHash(modelCase) {
  return sha256(canonicalJson(modelCase));
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (cell || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  const nonBlank = rows.filter((item) => item.some((value) => value !== ""));
  if (nonBlank.length === 0) return [];
  const headers = nonBlank[0];
  return nonBlank.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

export function validateOpeningRcfSource(modelCase, tolerance = 1e-8) {
  if (!hasBalancingRcf(modelCase)) {
    const policy = modelCase.rcf_policy ?? {};
    const errors = [];
    if (policy.instrument_id !== undefined) {
      errors.push({
        id: "rcf.none_instrument_designation",
        message: "No-balancing-facility mode cannot designate an instrument.",
      });
    }
    for (const key of ["capacity", "opening_draw", "commitment_fee_value"]) {
      if (Number(policy[key] ?? 0) !== 0) {
        errors.push({
          id: `rcf.none_nonzero_${key}`,
          message: `No-balancing-facility mode requires ${key} to be zero.`,
        });
      }
    }
    return errors;
  }
  const rcfInstrument = (modelCase.instruments ?? []).find(
    (instrument) =>
      instrument.instrument_id === modelCase.rcf_policy?.instrument_id,
  );
  const errors = [];
  if (!rcfInstrument || rcfInstrument.class !== "rcf") {
    errors.push({
      id: "rcf.instrument_source",
      message: "rcf_policy.instrument_id does not resolve to the single RCF instrument.",
    });
    return errors;
  }
  const openingPolicy = Number(modelCase.rcf_policy?.opening_draw);
  const openingInstrument = Number(rcfInstrument.opening_balance);
  if (
    !Number.isFinite(openingPolicy) ||
    !Number.isFinite(openingInstrument) ||
    Math.abs(openingPolicy - openingInstrument) > tolerance
  ) {
    errors.push({
      id: "rcf.opening_source_mismatch",
      message:
        "RCF opening draw has two conflicting sources; rcf_policy.opening_draw must equal the RCF instrument opening_balance.",
      policy_opening_draw: modelCase.rcf_policy?.opening_draw ?? null,
      instrument_opening_balance: rcfInstrument.opening_balance ?? null,
    });
  }
  const policyCapacity = Number(modelCase.rcf_policy?.capacity);
  const instrumentCapacity = Number(rcfInstrument.facility_capacity);
  if (
    !Number.isFinite(policyCapacity) ||
    !Number.isFinite(instrumentCapacity) ||
    Math.abs(policyCapacity - instrumentCapacity) > tolerance
  ) {
    errors.push({
      id: "rcf.capacity_source_mismatch",
      message:
        "RCF capacity has two conflicting sources; rcf_policy.capacity must equal the RCF instrument facility_capacity.",
      policy_capacity: modelCase.rcf_policy?.capacity ?? null,
      instrument_capacity: rcfInstrument.facility_capacity ?? null,
    });
  }
  return errors;
}

/**
 * DEFECT 0.6 — 52/53-WEEK FILERS HARD-FAILED A PROMISE NOBODY WOULD ASK THEM.
 *
 * This compared `String(period.date).slice(5)` against `issuer.fiscal_year_end`
 * as a literal `MM-DD` and raised a hard error on any disagreement. A large
 * share of US retailers, distributors and food companies close on the Saturday
 * nearest a date, so their year end MOVES — 2025-12-27, 2026-01-02, 2027-01-01
 * — and every one of them failed a check they could not satisfy. The user flow
 * states in terms that the fiscal calendar follows the company and the user is
 * never asked about it, so a hard failure here is the flow's promise breaking
 * against the model's own arithmetic.
 *
 * `issuer.fiscal_calendar` names which calendar is in force:
 *
 *   fixed_date   — the year end is the same month and day every year. The
 *                  literal MM-DD comparison is exactly right and is kept. This
 *                  is the default, so every existing case is unaffected.
 *   52_53_week   — the year end is the same WEEKDAY near an anchor date. The
 *                  MM-DD comparison is meaningless; what must hold is that
 *                  consecutive period ends are 52 or 53 weeks apart and land on
 *                  one weekday, and that each end sits within a week of the
 *                  declared anchor. That is a real check, not a waiver: a
 *                  transcription error of a single day still fails it.
 */
const WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

function fiscalCalendar(modelCase) {
  const declared = modelCase.issuer?.fiscal_calendar;
  return declared === undefined || declared === null ? "fixed_date" : declared;
}

function fixedDateFiscalPeriods(modelCase, match) {
  const errors = [];
  const expected = `${match[1]}-${match[2]}`;
  for (const [index, period] of (modelCase.periods ?? []).entries()) {
    if (String(period.date ?? "").slice(5) !== expected) {
      errors.push({
        id: "periods.fiscal_year_end_mismatch",
        period_index: index,
        period_date: period.date ?? null,
        expected_month_day: expected,
      });
    }
  }
  return errors;
}

function fiftyTwoWeekFiscalPeriods(modelCase, match) {
  const errors = [];
  const periods = modelCase.periods ?? [];
  const dates = periods.map((period) => new Date(`${period.date}T00:00:00Z`));
  for (const [index, date] of dates.entries()) {
    if (Number.isNaN(date.getTime())) {
      errors.push({
        id: "periods.invalid_period_date",
        period_index: index,
        period_date: periods[index]?.date ?? null,
      });
    }
  }
  if (errors.length > 0) return errors;
  // One closing weekday for the whole series.
  const weekdays = new Set(dates.map((date) => date.getUTCDay()));
  if (weekdays.size > 1) {
    errors.push({
      id: "periods.52_53_week_weekday_drift",
      message:
        "A 52/53-week filer closes on ONE weekday. These period ends fall on more than one.",
      weekdays: [...weekdays],
      period_dates: periods.map((period) => period.date ?? null),
    });
  }
  // 52 or 53 whole weeks between consecutive ends — nothing else is a fiscal year.
  for (let index = 1; index < dates.length; index += 1) {
    const span = dates[index].getTime() - dates[index - 1].getTime();
    const weeks = span / WEEK_MILLISECONDS;
    if (!Number.isInteger(weeks) || (weeks !== 52 && weeks !== 53)) {
      errors.push({
        id: "periods.52_53_week_span",
        period_index: index,
        period_date: periods[index]?.date ?? null,
        previous_period_date: periods[index - 1]?.date ?? null,
        weeks,
      });
    }
  }
  // Each end within a week of the declared anchor month and day.
  const anchorMonth = Number(match[1]);
  const anchorDay = Number(match[2]);
  for (const [index, date] of dates.entries()) {
    const year = date.getUTCFullYear();
    const nearest = [year - 1, year, year + 1]
      .map((candidate) => Date.UTC(candidate, anchorMonth - 1, anchorDay))
      .reduce((best, candidate) =>
        Math.abs(candidate - date.getTime()) < Math.abs(best - date.getTime())
          ? candidate
          : best,
      );
    if (Math.abs(nearest - date.getTime()) > WEEK_MILLISECONDS) {
      errors.push({
        id: "periods.52_53_week_anchor_drift",
        period_index: index,
        period_date: periods[index]?.date ?? null,
        anchor_month_day: `${match[1]}-${match[2]}`,
        message:
          "A 52/53-week year end is the chosen weekday NEAREST the anchor, so it cannot sit more than a week away from it.",
      });
    }
  }
  return errors;
}

export function validateFiscalPeriods(modelCase) {
  const fiscalYearEnd = String(modelCase.issuer?.fiscal_year_end ?? "");
  const match = fiscalYearEnd.match(/^(\d{2})-(\d{2})$/);
  if (!match) {
    return [
      {
        id: "periods.invalid_fiscal_year_end",
        message: "issuer.fiscal_year_end must use MM-DD.",
      },
    ];
  }
  const calendar = fiscalCalendar(modelCase);
  if (calendar === "52_53_week") {
    return fiftyTwoWeekFiscalPeriods(modelCase, match);
  }
  if (calendar !== "fixed_date") {
    return [
      {
        id: "periods.invalid_fiscal_calendar",
        message:
          "issuer.fiscal_calendar must be 'fixed_date' or '52_53_week'.",
        fiscal_calendar: calendar,
      },
    ];
  }
  return fixedDateFiscalPeriods(modelCase, match);
}

export function validateSolutionInvariants(solution, tolerance = 1e-8) {
  const errors = [];
  for (const result of solution.forecast ?? []) {
    if (
      Number(result.rcf_draw ?? 0) > tolerance &&
      Number(result.rcf_repayment ?? 0) > tolerance
    ) {
      errors.push({
        id: "rcf.draw_repay_mutual_exclusivity",
        period: result.period,
        draw: result.rcf_draw,
        repayment: result.rcf_repayment,
      });
    }
    const expectedShortfall = Math.max(
      0,
      Number(result.minimum_cash ?? 0) - Number(result.ending_cash ?? 0),
    );
    if (
      Math.abs(
        Number(result.liquidity_shortfall ?? 0) - expectedShortfall,
      ) > tolerance
    ) {
      errors.push({
        id: "liquidity.shortfall_identity",
        period: result.period,
        expected: expectedShortfall,
        actual: result.liquidity_shortfall,
      });
    }
    if (
      Number(result.liquidity_shortfall ?? 0) > tolerance &&
      Number(result.undrawn_rcf ?? 0) > tolerance
    ) {
      errors.push({
        id: "liquidity.shortfall_with_undrawn_capacity",
        period: result.period,
        shortfall: result.liquidity_shortfall,
        undrawn_rcf: result.undrawn_rcf,
      });
    }
    if (
      Math.abs(Number(result.acquisition_cash_consideration ?? 0)) > tolerance ||
      Math.abs(Number(result.acquisition_debt_proceeds ?? 0)) > tolerance ||
      Math.abs(Number(result.acquisition_debt_repayment ?? 0)) > tolerance
    ) {
      errors.push({
        id: "acquisition.direct_cash_flow_forbidden",
        period: result.period,
        consideration: result.acquisition_cash_consideration,
        proceeds: result.acquisition_debt_proceeds,
        repayment: result.acquisition_debt_repayment,
      });
    }
    for (const instrument of result.instrument_results ?? []) {
      // The COMPLETE set of movements that lawfully change an instrument's
      // native balance, mirroring the solver's own balance construction
      // (solver.mjs `ending_native`, self-checked as `debt_roll_forward`):
      //
      //   ending = opening + issuance + fair_value + other_non_cash + pik
      //                    - amortisation - maturity_repayment
      //
      // pik_interest_native and fair_value_movement_native were previously
      // ABSENT (defect D10), so every PIK or accreting instrument failed this
      // release-grade invariant by exactly its accretion while the solver was
      // correct. Adding them makes the check EXACT, not looser: it now also
      // catches a wrong PIK or fair-value amount, which it could not see at all
      // before. Any future movement term must be added here as well — every
      // term is proved load-bearing by scripts/run_roll_forward_invariant_tests.mjs,
      // which fails if the identity drops one.
      const expectedEnding =
        Number(instrument.opening_native ?? 0) +
        Number(instrument.issuance_native ?? 0) +
        Number(instrument.fair_value_movement_native ?? 0) +
        Number(instrument.other_non_cash_movement_native ?? 0) +
        Number(instrument.pik_interest_native ?? 0) -
        Number(instrument.amortisation_native ?? 0) -
        Number(instrument.maturity_repayment_native ?? 0);
      if (
        Math.abs(Number(instrument.ending_native ?? 0) - expectedEnding) >
        tolerance
      ) {
        errors.push({
          id: "debt.instrument_roll_forward",
          period: result.period,
          instrument_id: instrument.instrument_id,
          expected: expectedEnding,
          actual: instrument.ending_native,
        });
      }
    }
  }
  return errors;
}

export function validateSemanticArtifacts(manifest, crosswalkRows) {
  const errors = [];
  const nodes = manifest?.nodes ?? [];
  const edges = manifest?.edges ?? [];
  const sources = manifest?.source_inventory ?? [];
  const instrumentPeriodState = manifest?.instrument_period_state ?? null;
  const fullSemanticManifest = Boolean(
    manifest?.case_sha256 && manifest?.statement_topology,
  );
  if (fullSemanticManifest && !manifest?.layered_graph_constitution) {
    errors.push({
      id: "manifest.layered_graph_constitution_missing",
      message: "The semantic manifest requires the canonical layered graph closure proof.",
    });
  } else if (manifest?.layered_graph_constitution) {
    for (const message of validateLayeredGraphConstitution(
      manifest.layered_graph_constitution,
    )) {
      errors.push({
        id: "manifest.layered_graph_constitution_invalid",
        message,
      });
    }
    for (const violation of manifest.layered_graph_constitution.violations ?? []) {
      errors.push({
        id: `manifest.layered_graph_constitution.${violation.code}`,
        message: violation.message,
        context: violation,
      });
    }
  }
  if (Number(manifest?.contract_version) === 2 && !instrumentPeriodState) {
    errors.push({
      id: "manifest.instrument_period_state_missing",
      message: "A v2 semantic manifest requires the compiled instrument-period state.",
    });
  }
  if (instrumentPeriodState) {
    for (const message of validateInstrumentPeriodStateArtifact(
      instrumentPeriodState,
    )) {
      errors.push({
        id: "manifest.instrument_period_state_invalid",
        message,
      });
    }
    const forecastPeriodIds = (manifest?.periods ?? [])
      .filter((period) => period.status === "forecast")
      .map((period) => period.date);
    if (
      JSON.stringify(instrumentPeriodState.forecast_period_ids) !==
      JSON.stringify(forecastPeriodIds)
    ) {
      errors.push({
        id: "manifest.instrument_period_state_periods",
        expected: forecastPeriodIds,
        actual: instrumentPeriodState.forecast_period_ids,
      });
    }
    if (
      JSON.stringify(manifest?.definition_basis_graph ?? null) !==
      JSON.stringify(instrumentPeriodState.definition_basis_graph)
    ) {
      errors.push({
        id: "manifest.definition_basis_graph_binding",
        message: "The semantic definition-basis graph must be the graph carried by instrument-period state.",
      });
    }
    const stateById = new Map(
      instrumentPeriodState.states.map((state) => [state.state_id, state]),
    );
    for (const node of nodes.filter(
      (item) => item.node_kind === "debt_instrument",
    )) {
      const expectedStates = instrumentPeriodState.states
        .filter((state) => state.instrument_id === node.instrument_id)
        .sort((left, right) => left.period_index - right.period_index);
      const expectedIds = expectedStates.map((state) => state.state_id);
      if (
        JSON.stringify(node.instrument_period_state_ids ?? []) !==
        JSON.stringify(expectedIds)
      ) {
        errors.push({
          id: "manifest.instrument_period_state_node_binding",
          node_id: node.node_id,
          expected: expectedIds,
          actual: node.instrument_period_state_ids ?? [],
        });
      }
      for (const [index, stateId] of (
        node.instrument_period_state_ids ?? []
      ).entries()) {
        const state = stateById.get(stateId);
        if (
          !state ||
          JSON.stringify(node.instrument_period_membership?.[index] ?? null) !==
            JSON.stringify(state.inclusion)
        ) {
          errors.push({
            id: "manifest.instrument_period_membership_binding",
            node_id: node.node_id,
            state_id: stateId,
          });
        }
      }
    }
  }
  const nodeIds = new Set();
  const semanticIds = new Set();
  for (const node of nodes) {
    if (!node.node_id || nodeIds.has(node.node_id)) {
      errors.push({
        id: "manifest.node_id",
        node_id: node.node_id ?? null,
        message: "Manifest node IDs must be present and unique.",
      });
    }
    nodeIds.add(node.node_id);
    if (node.node_kind === "statement_row") {
      if (!node.semantic_id || semanticIds.has(node.semantic_id)) {
        errors.push({
          id: "manifest.semantic_id",
          node_id: node.node_id,
          semantic_id: node.semantic_id ?? null,
          message: "Statement semantic IDs must be present and unique.",
        });
      }
      semanticIds.add(node.semantic_id);
      if (
        ["calculation", "subtotal"].includes(node.row_type) &&
        node.formula_authority === "declared_dependency" &&
        (node.dependencies?.length ?? 0) === 0
      ) {
        errors.push({
          id: "manifest.calculation_dependencies",
          node_id: node.node_id,
          message: "Declared calculation nodes require semantic dependencies.",
        });
      }
      if (node.row_type !== "header") {
        const authorities = node.forecast_authorities;
        if (!Array.isArray(authorities) || authorities.length !== 3) {
          errors.push({
            id: "manifest.forecast_authorities",
            node_id: node.node_id,
            message: "Every non-header statement node requires three period forecast authorities.",
          });
        } else {
          for (const [forecastIndex, authority] of authorities.entries()) {
            const expectedMechanism = {
              schedule_link: "formula",
              accounting_identity: "formula",
              driver_formula: "formula",
              roll_forward: "formula",
              broker_consensus: "broker",
              actual_plus_remainder: "hardcode",
              contractual_commitment: "hardcode",
              company_guidance: "hardcode",
              company_indication: "hardcode",
              user_assumption: "hardcode",
              seasonal_run_rate: "formula",
              historical_average: "formula",
              historical_trend: "formula",
              carry_forward: "formula",
              explicit_zero: "zero",
              not_separately_forecast: "uncalculated",
              not_applicable: "uncalculated",
            }[authority?.method];
            if (
              Number(authority.forecast_index) !== forecastIndex ||
              !authority.method ||
              !["formula", "broker", "hardcode", "zero", "uncalculated"].includes(
                authority.mechanism,
              )
            ) {
              errors.push({
                id: "manifest.forecast_authority_shape",
                node_id: node.node_id,
                forecast_index: forecastIndex,
                authority,
              });
            }
            if (expectedMechanism && authority.mechanism !== expectedMechanism) {
              errors.push({
                id: "manifest.forecast_authority_mechanism",
                node_id: node.node_id,
                forecast_index: forecastIndex,
                method: authority.method,
                expected_mechanism: expectedMechanism,
                actual_mechanism: authority.mechanism ?? null,
              });
            }
            if (authority.method === "unresolved") {
              errors.push({
                id: "manifest.forecast_authority_unresolved",
                node_id: node.node_id,
                forecast_index: forecastIndex,
              });
            }
            if (
              authority.inferred !== true &&
              [
                "actual_plus_remainder",
                "contractual_commitment",
                "company_guidance",
                "company_indication",
              ].includes(authority.method) &&
              (!authority.source_id || !authority.as_of_date)
            ) {
              errors.push({
                id: "manifest.forecast_authority_provenance",
                node_id: node.node_id,
                forecast_index: forecastIndex,
              });
            }
            if (authority.method === "actual_plus_remainder") {
              const reported = Number(authority.partial_period?.reported_to_date);
              const remainder = Number(authority.partial_period?.forecast_remainder);
              const value = Number(authority.value);
              if (
                !Number.isFinite(reported) ||
                !Number.isFinite(remainder) ||
                !authority.partial_period?.reported_through ||
                !Number.isFinite(value) ||
                Math.abs(value - (reported + remainder)) > 1e-9
              ) {
                errors.push({
                  id: "manifest.forecast_authority_partial_period",
                  node_id: node.node_id,
                  forecast_index: forecastIndex,
                });
              }
            }
            if (
              ["explicit_zero", "not_separately_forecast", "not_applicable"].includes(
                authority.method,
              ) &&
              authority.inferred !== true &&
              !authority.note
            ) {
              errors.push({
                id: "manifest.forecast_authority_rationale",
                node_id: node.node_id,
                forecast_index: forecastIndex,
              });
            }
            if (
              (node.row_type === "uncalculated" ||
                node.formula_authority === "intentionally_blank") &&
              authority.mechanism !== "uncalculated"
            ) {
              errors.push({
                id: "manifest.structural_absence_conflict",
                node_id: node.node_id,
                forecast_index: forecastIndex,
                formula_authority: node.formula_authority ?? null,
                row_type: node.row_type ?? null,
                actual_mechanism: authority.mechanism ?? null,
                message:
                  "A structurally absent forecast row cannot retain a live or zero period authority.",
              });
            }
          }
        }
      }
      if (
        node.forecast_capture_parent_id &&
        node.forecast_capture_parent_id === node.row_id
      ) {
        errors.push({
          id: "manifest.forecast_capture_self_reference",
          node_id: node.node_id,
        });
      }
    }
    if (
      node.movement_type === "non_cash_debt_movement" &&
      node.waterfall_stage !== "excluded"
    ) {
      errors.push({
        id: "manifest.non_cash_debt_in_waterfall",
        node_id: node.node_id,
        waterfall_stage: node.waterfall_stage ?? null,
      });
    }
    if (
      ["rcf_draw", "rcf_repayment"].includes(node.movement_type) &&
      node.waterfall_stage !== "rcf_balance"
    ) {
      errors.push({
        id: "manifest.rcf_stage",
        node_id: node.node_id,
        waterfall_stage: node.waterfall_stage ?? null,
      });
    }
  }
  for (const edge of edges.filter((item) => item.edge_type === "depends_on")) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      errors.push({
        id: "manifest.unresolved_dependency",
        from: edge.from,
        to: edge.to,
      });
    }
  }
  const sourceIds = new Set();
  const crosswalkBySource = new Map();
  for (const row of crosswalkRows ?? []) {
    if (!crosswalkBySource.has(row.source_line_id)) {
      crosswalkBySource.set(row.source_line_id, []);
    }
    crosswalkBySource.get(row.source_line_id).push(row);
    if (!APPROVED_MAPPING_METHODS.has(row.mapping_method)) {
      errors.push({
        id: "crosswalk.mapping_method",
        source_line_id: row.source_line_id,
        mapping_method: row.mapping_method,
      });
    }
  }
  for (const source of sources) {
    if (!source.source_line_id || sourceIds.has(source.source_line_id)) {
      errors.push({
        id: "manifest.source_id",
        source_line_id: source.source_line_id ?? null,
      });
    }
    sourceIds.add(source.source_line_id);
    const rows = crosswalkBySource.get(source.source_line_id) ?? [];
    const resolved = rows.some((row) => row.mapping_status === "resolved");
    const documentedExclusion = rows.some(
      (row) =>
        row.mapping_status === "documented_exclusion" &&
        row.mapping_method === "not_applicable" &&
        String(row.reason ?? "").trim().length > 0,
    );
    if (source.material && !resolved && !documentedExclusion) {
      errors.push({
        id: "crosswalk.orphan_material_source",
        source_line_id: source.source_line_id,
      });
    }
    for (const destination of source.mapped_row_ids ?? []) {
      if (
        !rows.some(
          (row) =>
            row.destination_row_id === destination &&
            row.mapping_status === "resolved",
        )
      ) {
        errors.push({
          id: "crosswalk.missing_destination",
          source_line_id: source.source_line_id,
          destination_row_id: destination,
        });
      }
    }
  }
  for (const sourceLineId of crosswalkBySource.keys()) {
    if (!sourceIds.has(sourceLineId)) {
      errors.push({
        id: "crosswalk.unknown_source",
        source_line_id: sourceLineId,
      });
    }
  }
  return errors;
}

export function embeddedRateLiterals(formula) {
  const text = String(formula ?? "").replace(/^=/, "");
  const matches = [];
  const pattern =
    /(?:\*|\/|\+|-)\s*\(?\s*(-?(?:\d+(?:\.\d+)?|\.\d+))(?![A-Za-z0-9_])/g;
  const mechanicalConstants = new Set([0, 1, 2, 12, 360, 365, 10000]);
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (
      Number.isFinite(value) &&
      !mechanicalConstants.has(Math.abs(value))
    ) {
      matches.push({ literal: match[1], index: match.index });
    }
  }
  return matches;
}

const NATIVE_SCHEMA = "native-excel-restoration-evidence/3.2";
const NATIVE_SEQUENCE = [1, 0, 1, 0, 1];
const NATIVE_TOLERANCE_POLICY = {
  currency_abs: 1e-6,
  ratio_abs: 1e-9,
  percentage_abs: 1e-10,
  control_abs: 0,
  default_abs: 1e-9,
  relative: 1e-12,
};
const NATIVE_DRIFT_CLASSES = ["currency", "ratio", "percentage", "control", "default"];
const NATIVE_PROFILE_TESTS = {
  acquisition: {
    "native-excel-circularity-restoration-acquisition-case": "circularity",
    "native-excel-acquisition-restoration": "acquisition",
  },
  stressed_liquidity: {
    "native-excel-circularity-restoration-stressed-case": "circularity",
    "native-excel-maturity-restoration": "debt_maturities_roll",
  },
};
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_STATE_PATH = /^[^/\\]+(?:\/[^/\\]+)*$/;

function nativeError(errors, id, details = {}) {
  errors.push({ id, ...details });
}

function validHash(value) {
  return SHA256_PATTERN.test(String(value ?? ""));
}

function safeStatePath(value) {
  const text = String(value ?? "");
  return Boolean(
    text &&
      SAFE_STATE_PATH.test(text) &&
      !text.startsWith("/") &&
      text.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );
}

function exactIntegerList(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((wanted, index) =>
      Number.isInteger(value[index]) && value[index] === wanted,
    )
  );
}

function validNativeDrift(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["max_abs_by_class", "max_rel_by_class"].every((channel) => {
    const classes = value[channel];
    return classes && typeof classes === "object" && !Array.isArray(classes) &&
      NATIVE_DRIFT_CLASSES.every((name) =>
        Number.isFinite(classes[name]) && classes[name] >= 0,
      );
  });
}

/** Fail-closed validation of aggregate, hash-bound native-Excel evidence. */
export function validateNativeEvidence(inputEvidence, inputExpected) {
  const errors = [];
  const evidence = inputEvidence && typeof inputEvidence === "object" && !Array.isArray(inputEvidence)
    ? inputEvidence
    : {};
  const expected = inputExpected && typeof inputExpected === "object" && !Array.isArray(inputExpected)
    ? inputExpected
    : {};

  if (evidence.schema_version !== NATIVE_SCHEMA) {
    nativeError(errors, "native.schema_version", {
      expected: NATIVE_SCHEMA,
      actual: evidence.schema_version ?? null,
    });
  }
  if (evidence.status !== "PASS") {
    nativeError(errors, "native.status", { message: "Native evidence must be PASS." });
  }
  if (evidence.diagnostic_only !== false) nativeError(errors, "native.diagnostic_only");
  if (!["Microsoft Excel for Mac", "Microsoft Excel for Windows"].includes(evidence.application)) {
    nativeError(errors, "native.application", { actual: evidence.application ?? null });
  }
  if (String(evidence.method ?? "").trim().length === 0) nativeError(errors, "native.method");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(evidence.generated_at ?? ""))) {
    nativeError(errors, "native.generated_at", { actual: evidence.generated_at ?? null });
  }
  if (!Number.isInteger(evidence.total_violations) || evidence.total_violations !== 0) {
    nativeError(errors, "native.total_violations", { actual: evidence.total_violations ?? null });
  }
  if (!validHash(evidence.certified_closure_sha256)) {
    nativeError(errors, "native.certified_closure_sha256", { actual: evidence.certified_closure_sha256 ?? null });
  }
  if (JSON.stringify(evidence.tolerance_policy) !== JSON.stringify(NATIVE_TOLERANCE_POLICY)) {
    nativeError(errors, "native.tolerance_policy", { expected: NATIVE_TOLERANCE_POLICY, actual: evidence.tolerance_policy ?? null });
  }

  const evidenceHash = evidence.evidence_sha256;
  const hashBody = { ...evidence };
  delete hashBody.evidence_sha256;
  const calculatedHash = sha256(canonicalJson(hashBody));
  if (!validHash(evidenceHash) || evidenceHash !== calculatedHash) {
    nativeError(errors, "native.evidence_sha256", {
      expected: calculatedHash,
      actual: evidenceHash ?? null,
    });
  }

  const requiredIds = Object.values(NATIVE_PROFILE_TESTS).flatMap((tests) => Object.keys(tests));
  const requiredProfiles = Object.keys(NATIVE_PROFILE_TESTS);
  let matrix = evidence.release_matrix;
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    nativeError(errors, "native.release_matrix");
    matrix = {};
  }
  if (matrix.status !== "PASS") nativeError(errors, "native.release_matrix.status");
  if (JSON.stringify(matrix.required_test_ids) !== JSON.stringify(requiredIds)) {
    nativeError(errors, "native.release_matrix.required_test_ids", {
      expected: requiredIds,
      actual: matrix.required_test_ids ?? null,
    });
  }
  if (JSON.stringify(matrix.candidate_profiles) !== JSON.stringify(requiredProfiles)) {
    nativeError(errors, "native.release_matrix.candidate_profiles", {
      expected: requiredProfiles,
      actual: matrix.candidate_profiles ?? null,
    });
  }

  let candidates = evidence.candidates;
  if (!Array.isArray(candidates)) {
    nativeError(errors, "native.candidates");
    candidates = [];
  }
  const profiles = candidates.filter((candidate) => candidate && typeof candidate === "object")
    .map((candidate) => candidate.profile);
  if (
    candidates.length !== 2 ||
    JSON.stringify(profiles) !== JSON.stringify(requiredProfiles) ||
    new Set(profiles).size !== profiles.length
  ) {
    nativeError(errors, "native.candidate_profiles", {
      expected: requiredProfiles,
      actual: profiles,
    });
  }

  const bindingKeys = [
    "case_id",
    "case_sha256",
    "workbook_sha256",
    "semantic_manifest_sha256",
    "row_map_sha256",
  ];
  const allTestIds = [];
  const matchingCandidates = [];
  candidates.forEach((candidate, candidateIndex) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      nativeError(errors, "native.candidate", { candidate_index: candidateIndex });
      return;
    }
    const profile = candidate.profile;
    const prefix = `native.candidate.${profile ?? candidateIndex}`;
    const profileTests = NATIVE_PROFILE_TESTS[profile] ?? {};
    if (!(profile in NATIVE_PROFILE_TESTS)) {
      nativeError(errors, `${prefix}.profile`, { actual: profile ?? null });
    }
    for (const key of bindingKeys) {
      const value = candidate[key];
      const valid = key === "case_id" ? String(value ?? "").trim().length > 0 : validHash(value);
      if (!valid) nativeError(errors, `${prefix}.${key}`, { actual: value ?? null });
    }

    let snapshotRecord = candidate.candidate_snapshot;
    if (!snapshotRecord || typeof snapshotRecord !== "object" || Array.isArray(snapshotRecord)) {
      nativeError(errors, `${prefix}.candidate_snapshot`);
      snapshotRecord = {};
    }
    if (!Array.isArray(snapshotRecord.sheet_names) || snapshotRecord.sheet_names.length === 0) {
      nativeError(errors, `${prefix}.candidate_snapshot.sheet_names`);
    }
    if (!snapshotRecord.calculation_settings || typeof snapshotRecord.calculation_settings !== "object" || Array.isArray(snapshotRecord.calculation_settings)) {
      nativeError(errors, `${prefix}.candidate_snapshot.calculation_settings`);
    }
    for (const signature of ["formula_signature", "numeric_signature", "structure_signature"]) {
      if (!validHash(snapshotRecord[signature])) {
        nativeError(errors, `${prefix}.candidate_snapshot.${signature}`);
      }
    }

    let tests = candidate.tests;
    if (!Array.isArray(tests)) {
      nativeError(errors, `${prefix}.tests`);
      tests = [];
    }
    const testIds = tests.filter((test) => test && typeof test === "object").map((test) => test.id);
    allTestIds.push(...testIds);
    if (tests.length !== Object.keys(profileTests).length || JSON.stringify(testIds) !== JSON.stringify(Object.keys(profileTests))) {
      nativeError(errors, `${prefix}.test_ids`, {
        expected: Object.keys(profileTests),
        actual: testIds,
      });
    }

    tests.forEach((test, testIndex) => {
      if (!test || typeof test !== "object" || Array.isArray(test)) {
        nativeError(errors, `${prefix}.test`, { test_index: testIndex });
        return;
      }
      const testId = test.id;
      const testPrefix = `${prefix}.test.${testId ?? testIndex}`;
      const expectedControl = profileTests[testId];
      if (expectedControl === undefined) nativeError(errors, `${testPrefix}.id`, { actual: testId ?? null });
      if (test.control_id !== expectedControl) {
        nativeError(errors, `${testPrefix}.control_id`, {
          expected: expectedControl ?? null,
          actual: test.control_id ?? null,
        });
      }
      if (test.status !== "PASS") nativeError(errors, `${testPrefix}.status`);
      if (!Array.isArray(test.failures) || test.failures.length !== 0) {
        nativeError(errors, `${testPrefix}.failures`, { actual: test.failures ?? null });
      }
      if (!exactIntegerList(test.expected_sequence, NATIVE_SEQUENCE)) nativeError(errors, `${testPrefix}.expected_sequence`);
      if (!exactIntegerList(test.actual_sequence, NATIVE_SEQUENCE)) nativeError(errors, `${testPrefix}.actual_sequence`);
      if (!String(test.control_cell ?? "").startsWith("Operating Model!")) nativeError(errors, `${testPrefix}.control_cell`);
      if (JSON.stringify(test.tolerance_policy) !== JSON.stringify(NATIVE_TOLERANCE_POLICY)) {
        nativeError(errors, `${testPrefix}.tolerance_policy`);
      }
      if (!validNativeDrift(test.max_observed_drift)) {
        nativeError(errors, `${testPrefix}.max_observed_drift`);
      }

      let files = test.files;
      if (!Array.isArray(files) || files.length !== 5) {
        nativeError(errors, `${testPrefix}.files`);
        files = [];
      }
      const paths = [];
      const hashes = [];
      files.forEach((state, stateIndex) => {
        if (!state || typeof state !== "object" || Array.isArray(state)) {
          nativeError(errors, `${testPrefix}.file`, { state_index: stateIndex });
          return;
        }
        paths.push(state.path);
        hashes.push(state.sha256);
        if (!safeStatePath(state.path)) nativeError(errors, `${testPrefix}.file.path`, { actual: state.path ?? null });
        if (!validHash(state.sha256)) nativeError(errors, `${testPrefix}.file.sha256`, { actual: state.sha256 ?? null });
        for (const field of ["worksheets_scanned", "used_cells_scanned"]) {
          if (!Number.isInteger(state[field]) || state[field] <= 0) {
            nativeError(errors, `${testPrefix}.file.${field}`, {
              state_index: stateIndex,
              actual: state[field] ?? null,
            });
          }
        }
        if (state.excel_error_count !== 0) {
          nativeError(errors, `${testPrefix}.file.excel_error_count`, {
            state_index: stateIndex,
            actual: state.excel_error_count ?? null,
          });
        }
        if (!Array.isArray(state.excel_error_cells) || state.excel_error_cells.length !== 0) {
          nativeError(errors, `${testPrefix}.file.excel_error_cells`, {
            state_index: stateIndex,
            actual: state.excel_error_cells ?? null,
          });
        }
      });
      if (new Set(paths).size !== paths.length) nativeError(errors, `${testPrefix}.file.duplicate_path`);
      if (new Set(hashes).size < 2) nativeError(errors, `${testPrefix}.file.insufficient_distinct_sha256`);

      for (const field of ["formula_cells_compared", "numeric_cells_compared"]) {
        if (!Number.isInteger(test[field]) || test[field] <= 0) nativeError(errors, `${testPrefix}.${field}`, { actual: test[field] ?? null });
      }
      for (const [field, expectedCounts] of [
        ["on_restoration_difference_counts", [0, 0]],
        ["off_restoration_difference_counts", [0]],
      ]) {
        if (!exactIntegerList(test[field], expectedCounts)) nativeError(errors, `${testPrefix}.${field}`, { actual: test[field] ?? null });
      }
      for (const field of ["declared_effect_cells_present", "declared_effect_cells_changed"]) {
        if (!Number.isInteger(test[field]) || test[field] <= 0) nativeError(errors, `${testPrefix}.${field}`, { actual: test[field] ?? null });
      }
      const declaredEffects = test.declared_effect_cells;
      const effectsPresent = test.declared_effect_cells_present;
      const effectsChanged = test.declared_effect_cells_changed;
      if (
        !Number.isInteger(declaredEffects) ||
        declaredEffects <= 0 ||
        !Number.isInteger(effectsPresent) ||
        !Number.isInteger(effectsChanged) ||
        !(effectsChanged > 0 && effectsChanged <= effectsPresent && effectsPresent <= declaredEffects)
      ) {
        nativeError(errors, `${testPrefix}.declared_effect_count_consistency`);
      }
      if (!Number.isInteger(test.on_off_difference_count_excluding_control) || test.on_off_difference_count_excluding_control <= 0) {
        nativeError(errors, `${testPrefix}.on_off_difference_count_excluding_control`);
      } else if (Number.isInteger(effectsChanged) && test.on_off_difference_count_excluding_control < effectsChanged) {
        nativeError(errors, `${testPrefix}.on_off_difference_count_consistency`);
      }
      if (["circularity", "acquisition"].includes(expectedControl)) {
        if (!Number.isInteger(test.declared_kill_switch_cells) || test.declared_kill_switch_cells <= 0) nativeError(errors, `${testPrefix}.declared_kill_switch_cells`);
        if (!Number.isInteger(test.declared_kill_switch_nonzero_on) || test.declared_kill_switch_nonzero_on <= 0) nativeError(errors, `${testPrefix}.declared_kill_switch_nonzero_on`);
        else if (test.declared_kill_switch_nonzero_on > test.declared_kill_switch_cells) nativeError(errors, `${testPrefix}.declared_kill_switch_count_consistency`);
      }
      if (test.declared_kill_switch_bad_off !== 0) nativeError(errors, `${testPrefix}.declared_kill_switch_bad_off`);

      let binding = test.candidate_binding;
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        nativeError(errors, `${testPrefix}.candidate_binding`);
        binding = {};
      }
      if (binding.status !== "PASS" || !Array.isArray(binding.failures) || binding.failures.length !== 0) {
        nativeError(errors, `${testPrefix}.candidate_binding.status`);
      }
      for (const field of [
        "formula_signature_match",
        "structure_signature_match",
        "sheet_order_match",
        "calculation_settings_match",
      ]) {
        if (binding[field] !== true) nativeError(errors, `${testPrefix}.candidate_binding.${field}`);
      }
      if (binding.numeric_difference_count !== 0) nativeError(errors, `${testPrefix}.candidate_binding.numeric_difference_count`);
      if (!validNativeDrift(binding.max_observed_drift)) nativeError(errors, `${testPrefix}.candidate_binding.max_observed_drift`);
      if (binding.candidate_control_value !== 1 || binding.state_1_control_value !== 1) nativeError(errors, `${testPrefix}.candidate_binding.control_values`);
      if (binding.candidate_workbook_sha256 !== candidate.workbook_sha256) nativeError(errors, `${testPrefix}.candidate_binding.workbook_sha256`);
      for (const [bindingField, snapshotField] of [
        ["candidate_formula_signature", "formula_signature"],
        ["candidate_structure_signature", "structure_signature"],
      ]) {
        if (!validHash(binding[bindingField]) || binding[bindingField] !== snapshotRecord[snapshotField]) {
          nativeError(errors, `${testPrefix}.candidate_binding.${bindingField}`);
        }
      }
      for (const bindingField of ["state_1_formula_signature", "state_1_structure_signature"]) {
        if (!validHash(binding[bindingField])) nativeError(errors, `${testPrefix}.candidate_binding.${bindingField}`);
      }
      if (binding.state_1_formula_signature !== binding.candidate_formula_signature) nativeError(errors, `${testPrefix}.candidate_binding.formula_signature_consistency`);
      if (binding.state_1_structure_signature !== binding.candidate_structure_signature) nativeError(errors, `${testPrefix}.candidate_binding.structure_signature_consistency`);
      const stateOneHash = files[0]?.sha256;
      if (binding.state_1_sha256 !== stateOneHash) nativeError(errors, `${testPrefix}.candidate_binding.state_1_sha256`);
    });

    if (bindingKeys.every((key) => expected[key] && candidate[key] === expected[key])) {
      matchingCandidates.push(candidate);
    }
  });

  if (
    JSON.stringify(matrix.actual_test_ids) !== JSON.stringify(allTestIds) ||
    JSON.stringify(allTestIds) !== JSON.stringify(requiredIds) ||
    new Set(allTestIds).size !== allTestIds.length
  ) {
    nativeError(errors, "native.release_matrix.actual_test_ids", {
      expected: requiredIds,
      actual: matrix.actual_test_ids ?? null,
      candidate_tests: allTestIds,
    });
  }
  const missingExpected = bindingKeys.filter((key) => !expected[key]);
  if (missingExpected.length > 0) nativeError(errors, "native.expected_bindings", { missing: missingExpected });
  if (matchingCandidates.length !== 1) {
    nativeError(errors, "native.binding.candidate", {
      expected: Object.fromEntries(bindingKeys.map((key) => [key, expected[key] ?? null])),
      matches: matchingCandidates.length,
    });
  }
  return errors;
}
