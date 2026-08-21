// The user-facing screens of the Debt Overlay skill.
//
// Everything in this module is a pure function from data to a string. No screen
// reads a file, solves a case or decides anything: the decisions are made in
// flow_questions.mjs, flow_reconcile.mjs and flow_read.mjs, and arrive here as
// already-resolved data. That separation is what lets the fixtures assert on
// decisions without asserting on typography, and on typography without running
// a solver.
//
import { createHash } from "node:crypto";

import {
  SCREEN_CONTRACT,
  stageById,
  VISIBLE_MILESTONES,
  visibleJourneyProgress,
} from "./flow_runtime.mjs";
import {
  forecastRowMateriality,
  resolveForecastAuthority,
} from "./forecast_authority.mjs";

const RULE_WIDTH = SCREEN_CONTRACT.width;
const RULE = `  ${"-".repeat(RULE_WIDTH - 2)}`;

const ASCII_REPLACEMENTS = Object.freeze([
  [/€/g, "EUR"],
  [/£/g, "GBP"],
  [/¥/g, "JPY"],
  [/[–—]/g, "-"],
  [/←/g, "<-"],
  [/→/g, "->"],
  [/⚠/g, "WARNING:"],
]);

export function asciiText(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of ASCII_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text.normalize("NFKD").replace(/[^\x00-\x7F·]/g, "?");
}

// ── company language (generalised from lintQuestion) ───────────────────────
//
// flow_questions.mjs enforces company language on question prompts: a prompt
// may not name the model's internal vocabulary. The same rule applies to every
// screen: the reader is a company person, not the controller, and the ten
// phrases below are controller dialect — provenance plumbing, degradation
// machinery and receipt bookkeeping that mean nothing on the page.
//
// `lintScreenLanguage` DETECTS; `plainCompanyLanguage` REPLACES. Every screen
// passes through finishScreen, which applies the replacement pass to ALL
// renderer output — including text interpolated from upstream artifacts the
// screens do not author — so a banned phrase can no longer reach the page even
// when the data carrying it is owned elsewhere. Session nonce and host-marker
// text is deliberately untouched: it is security furniture, not jargon.
export const BANNED_SCREEN_LANGUAGE = Object.freeze([
  Object.freeze({
    term: "FORECAST WATERFALL",
    pattern: /\bforecast[\s_-]*waterfall\b/gi,
    replacement: "fallback forecast",
  }),
  Object.freeze({
    term: "House id",
    pattern: /\bhouse[\s_-]*ids?\b/gi,
    replacement: "house",
  }),
  Object.freeze({
    term: "attestation SHA-256",
    pattern: /\battestation[\s_-]*sha[- ]?256\b/gi,
    replacement: "delivery proof record",
  }),
  Object.freeze({
    term: "stage receipt",
    pattern: /\bstage[\s_-]*receipts?\b/gi,
    replacement: "run record",
  }),
  Object.freeze({
    term: "custody",
    pattern: /\bcustod(y|ies|iary)\b/gi,
    replacement: "safekeeping",
  }),
  Object.freeze({
    term: "quarantine",
    pattern: /\bquarantin(?:e|es|ed|ing)\b/gi,
    replacement: "set aside",
  }),
  Object.freeze({
    term: "authority contract",
    pattern: /\bauthority[\s_-]*contracts?\b/gi,
    replacement: "authority agreement",
  }),
  Object.freeze({
    term: "model authority",
    pattern: /\bmodel[\s_-]*authority\b/gi,
    replacement: "the model's inputs",
  }),
  Object.freeze({
    term: "Preview hash",
    pattern: /\bpreview[\s_-]*hash\b/gi,
    replacement: "preview record",
  }),
  Object.freeze({
    term: "design epoch",
    pattern: /\bdesign[\s_-]*epochs?\b/gi,
    replacement: "design version",
  }),
]);

/** Every banned phrase present in `text`, with the match that fired. */
export function lintScreenLanguage(text) {
  const source = String(text ?? "");
  const detections = [];
  for (const entry of BANNED_SCREEN_LANGUAGE) {
    const pattern = new RegExp(entry.pattern.source, entry.pattern.flags);
    let match;
    while ((match = pattern.exec(source)) !== null) {
      detections.push({ term: entry.term, matched: match[0] });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  return detections;
}

/** `text` with every banned phrase rewritten to its plain replacement. */
export function plainCompanyLanguage(text) {
  let out = String(text ?? "");
  for (const entry of BANNED_SCREEN_LANGUAGE) {
    out = out.replace(entry.pattern, entry.replacement);
  }
  return out;
}

export function inspectScreen(screen) {
  const rendered = String(screen ?? "");
  const body = rendered.startsWith("```text\n") && rendered.endsWith("\n```")
    ? rendered.slice(8, -4)
    : rendered;
  const lines = body.split("\n");
  const semanticBody = body.replace(/\s+/g, " ");
  const violations = [];
  const allowedNonAscii = new Set(SCREEN_CONTRACT.allowed_non_ascii ?? []);
  const unexpectedNonAscii = [...body].filter(
    (character) => character.codePointAt(0) > 0x7f && !allowedNonAscii.has(character),
  );
  if (unexpectedNonAscii.length > 0) {
    violations.push("screen contains an undeclared non-ASCII character");
  }
  lines.forEach((line, index) => {
    if (displayWidth(line) > RULE_WIDTH) {
      violations.push(
        `line ${index + 1} is ${displayWidth(line)} columns; limit is ${RULE_WIDTH}`,
      );
    }
  });
  if (lines.length > SCREEN_CONTRACT.max_lines) {
    violations.push(
      `screen has ${lines.length} lines; limit is ${SCREEN_CONTRACT.max_lines}`,
    );
  }
  if (/\bSTAGE\s+\d+\s+OF\s+\d+\b/i.test(semanticBody)) {
    violations.push(
      "screen exposes internal controller numbering beside the six-milestone journey",
    );
  }
  const actionRequired = /STATUS:\s*ACTION REQUIRED/i.test(semanticBody);
  const inProgress = /STATUS:\s*IN PROGRESS/i.test(semanticBody);
  const hasActionInstrument =
    /NEXT ACTION/i.test(semanticBody) ||
    /\+--\[ REPLY \]/i.test(semanticBody) ||
    /Answer the question cards below\./i.test(semanticBody);
  if (actionRequired && !hasActionInstrument) {
    violations.push("action-required screen has no explicit reply instrument");
  }
  const saysNoResponse = /no response is required/i.test(semanticBody);
  if (inProgress && !saysNoResponse) {
    violations.push("in-progress screen does not state that no response is required");
  }
  if (
    saysNoResponse &&
    (actionRequired || /NEXT ACTION/i.test(semanticBody) || /\+--\[ REPLY \]/i.test(semanticBody))
  ) {
    violations.push(
      "screen says no response is required while also presenting a user action",
    );
  }
  return { ok: violations.length === 0, lines: lines.length, violations };
}

function finishScreen(lines, { summariseOverflow = false } = {}) {
  // Company language is enforced here, at the one door every screen passes
  // through: banned controller dialect is rewritten to its plain replacement
  // before the screen contract is checked, so no renderer — and no upstream
  // artifact a renderer quotes — can put jargon on the page.
  let clean = lines.map((line) => plainCompanyLanguage(asciiText(line)));
  if (summariseOverflow && clean.length > SCREEN_CONTRACT.max_lines) {
    clean = [
      ...clean.slice(0, SCREEN_CONTRACT.max_lines - 3),
      "",
      "   More detail is preserved in the run record.",
      RULE,
    ];
  }
  const screen = clean.join("\n").replace(/\n+$/, "");
  const inspected = inspectScreen(screen);
  if (!inspected.ok) {
    throw new Error(`Screen contract violation: ${inspected.violations.join("; ")}`);
  }
  // One fenced text block is the user-interface boundary. It preserves
  // monospacing in every host and prevents a stage screen from being rendered
  // as proportional prose or a markdown list.
  return `\`\`\`text\n${screen}\n\`\`\``;
}

export function renderStageHeader(stageId, status) {
  const stage = stageById(stageId);
  if (!stage) throw new Error(`Unknown user-flow stage: ${stageId}`);
  const progress = visibleJourneyProgress(stageId, status);
  const suffix = progress.active_label
    ? ` - ${progress.active_label.toUpperCase()} IN PROGRESS`
    : progress.next_label
      ? ` - ${progress.next_label.toUpperCase()} NEXT`
      : "";
  return [
    RULE,
    `   PROGRESS: ${progress.completed} OF ${progress.total} COMPLETE${suffix}`,
    `   CHECKPOINT: ${progress.checkpoint}`,
    `   STATUS: ${asciiText(status).toUpperCase()}`,
    RULE,
  ];
}

export function renderStageStatus({ stageId, status, summary, nextAction = null }) {
  const lines = [...renderStageHeader(stageId, status), ""];
  for (const line of indented(summary, 3, RULE_WIDTH - 3)) lines.push(line);
  if (nextAction) {
    lines.push("", "   NEXT ACTION");
    for (const line of indented(nextAction, 3, RULE_WIDTH - 3)) lines.push(line);
  }
  lines.push("", RULE);
  return finishScreen(lines);
}

/**
 * The REVIEW gate's screen: the last look before a workbook is delivered.
 * Render-only — it draws what the build already produced (the quality mode,
 * headline numbers, the plain-English read, stated assumptions and judgement
 * calls) and names the gate's exactly two replies. The gate itself lives in
 * run_user_flow.mjs; this screen decides nothing and is reused for both the
 * blocked pause and the recorded change request.
 */
export function renderReviewGateScreen(briefing) {
  const periods = (Array.isArray(briefing?.periods) ? briefing.periods : [])
    .map((period) => String(period ?? "").slice(0, 4));
  const quality = briefing?.quality ?? {};
  const lines = [
    RULE,
    "   REVIEW BEFORE DELIVERY",
    RULE,
    "",
    `   ${String(briefing?.issuer ?? "Issuer").slice(0, RULE_WIDTH - 6).trimEnd()}`,
    `   Forecast years .......... ${periods.join(", ") || "none"}`,
    `   Reporting basis ......... ${briefing?.reporting_currency ?? "not reported"}`,
    "",
    `   QUALITY: ${String(quality.mode ?? "NOT ASSESSED").toUpperCase()}`,
    ...indented(quality.detail ?? "", 3, RULE_WIDTH - 3),
    "",
    "   HEADLINE FORECAST",
  ];
  for (const row of Array.isArray(briefing?.headline) ? briefing.headline : []) {
    lines.push(
      `   ${String(row?.period ?? "").slice(0, 4)}  net debt ${previewNumber(row?.net_debt)}  leverage ${previewNumber(row?.net_leverage)}  cash ${previewNumber(row?.total_liquidity)}`,
    );
  }
  lines.push("", "   THE MODEL IN PLAIN WORDS");
  const readLines = indented(briefing?.read ?? "", 3, RULE_WIDTH - 3)
    .filter((line) => line.trim() !== "");
  lines.push(...readLines.slice(0, 12));
  if (readLines.length > 12) {
    lines.push("   ... the full read arrives with the workbook.");
  }
  const assumptions = (Array.isArray(briefing?.top_assumptions)
    ? briefing.top_assumptions
    : []
  ).slice(0, 4);
  if (assumptions.length > 0) {
    lines.push("", "   STATED ASSUMPTIONS");
    for (const assumption of assumptions) {
      lines.push(...indented(`- ${assumption}`, 3, RULE_WIDTH - 3));
    }
  }
  const plausibleOnly = (Array.isArray(briefing?.plausible_only)
    ? briefing.plausible_only
    : []
  ).slice(0, 4);
  if (plausibleOnly.length > 0) {
    lines.push("", "   NUMBERS THAT DEPEND ON JUDGEMENT");
    for (const check of plausibleOnly) {
      lines.push(...indented(`- ${check}`, 3, RULE_WIDTH - 3));
    }
  }
  lines.push(
    "",
    "   The last look before delivery. Exactly two replies:",
    "",
    "   reply: deliver - deliver the workbook as it stands",
    "   reply: change <what to change> - stop here; nothing",
    "       is delivered and the note is recorded",
    "",
    "   No other reply leaves the run waiting at this gate.",
    "",
    RULE,
  );
  return finishScreen(lines);
}

export function renderEvidenceReviewProgress(evidenceRun) {
  const filingPeriods = evidenceRun?.filings?.historical_periods ?? [];
  const fiscalLabels = filingPeriods.map((value) => {
    const year = /^\d{4}/.exec(String(value ?? ""))?.[0];
    return year ? `FY${year}` : String(value);
  });
  const brokerHouseCount = evidenceRun?.broker_pack?.houses?.length ?? 0;
  const dcsCounts = evidenceRun?.dcs_evidence_receipt?.counts ??
    evidenceRun?.case_evidence?.lanes?.dcs?.compiler_receipt?.counts ?? {};
  const reportingCurrency =
    evidenceRun?.case_source?.identity?.reporting_currency ??
    evidenceRun?.filings?.reporting_currency ??
    "not reported";
  const units =
    evidenceRun?.case_source?.identity?.units ??
    evidenceRun?.filings?.units ??
    "not reported";
  const lines = [
    ...renderStageHeader("evidence_review", "in progress"),
    "",
    `   ${evidenceRun?.company_name ?? evidenceRun?.filings?.entity_name ?? "Issuer"}`,
    "",
    "   INPUT PACK RECEIVED",
    "",
    `   Filing periods ........ ${fiscalLabels.join("-") || "not reported"}`,
    `   Broker houses ......... ${brokerHouseCount}`,
    "   FactSet debt export ... received",
    `   Debt snapshot ......... ${filingPeriods.at(-1) ?? "not reported"}`,
    `   Reporting basis ....... ${reportingCurrency} ${units}`,
    `   FactSet debt rows ..... ${dcsCounts.source_rows ?? "not reported"}`,
    `   FactSet populated cells ${dcsCounts.source_cells ?? "not reported"}`,
    "",
    "   The controller is reconciling the issuer, periods,",
    "   statements, debt instruments and broker forecasts.",
    "   It continues automatically; no response is required.",
    "",
    RULE,
  ];
  return finishScreen(lines);
}

function previewNumber(value) {
  if (!Number.isFinite(Number(value))) return "-";
  const number = Number(value);
  if (Math.abs(number) >= 1000) return number.toFixed(0);
  if (Math.abs(number) >= 10) return number.toFixed(1).replace(/\.0$/, "");
  return number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * The input-pack review's broker checkpoint. The compact screen is a readable
 * receipt; the adjacent JSON artifact carries every cell-addressed provenance
 * record and every alternate without forcing a 500-line chat response.
 */
export function renderBrokerPreviewScreen(preview, { confirmationErrors = [] } = {}) {
  const waterfallMode = preview?.selection_mode === "forecast_waterfall";
  const zeroBrokerPolicy = preview?.broker_authority_policy === "zero_broker";
  const selected = (preview?.selection_cases ?? []).find(
    (candidate) => candidate.house_id === preview?.recommended_primary_house_id,
  );
  const byMetric = new Map();
  for (const value of selected?.selected_values ?? []) {
    const record = byMetric.get(value.metric_id) ?? {
      metric_id: value.metric_id,
      kind: value.selection_kind,
      values: [null, null, null],
    };
    record.values[value.period_index] = value.value;
    byMetric.set(value.metric_id, record);
  }
  const lines = [
    ...renderStageHeader(
      "evidence_review",
      confirmationErrors.length > 0
        ? "complete - optional override ignored"
        : "complete",
    ),
    "",
    "   SEALED BROKER PREVIEW",
    "",
    `   Raw houses preserved .... ${preview?.evidence_inventory?.raw_house_count ?? 0}`,
    `   Raw tables preserved .... ${preview?.evidence_inventory?.raw_table_count ?? 0}`,
    `   Evidence-only tables .... ${preview?.evidence_inventory?.evidence_only_table_count ?? 0}`,
    `   Cells set aside ........ ${preview?.evidence_inventory?.quarantined_cell_count ?? 0}`,
    "",
    `   SELECTION MODE ......... ${waterfallMode ? "NO SINGLE BROKER HOUSE" : "PRIMARY HOUSE"}`,
    `   RECOMMENDED PRIMARY: ${selected?.house_name ?? (waterfallMode ? "none - no coherent primary house" : "none")}`,
    `   Headline anchor ........ ${preview?.headline_anchor ?? "none"}`,
    "",
    "   SELECTED MODEL VALUES       FY1       FY2       FY3",
  ];
  for (const record of [...byMetric.values()].sort((a, b) =>
    a.metric_id.localeCompare(b.metric_id))) {
    const label = record.metric_id.replace(/_/g, " ").slice(0, 24).padEnd(24);
    const values = record.values
      .map((value) => previewNumber(value).padStart(9))
      .join(" ");
    lines.push(`   ${label}${values}`);
  }
  const alternatives = (preview?.selection_cases ?? [])
    .filter((candidate) => candidate.status === "PASS")
    .filter((candidate) => candidate.house_id !== selected?.house_id);
  lines.push("", "   ELIGIBLE ALTERNATES");
  if (alternatives.length === 0) lines.push("   None");
  else {
    for (const candidate of alternatives) {
      lines.push(`   ${candidate.house_id} - ${candidate.house_name}`);
    }
  }
  if (waterfallMode) {
    lines.push("", "   WHERE EACH FORECAST NUMBER CAME FROM");
    for (const reason of preview?.forecast_waterfall_reasons ?? []) {
      for (const line of indented(reason, 3, RULE_WIDTH - 3)) lines.push(line);
    }
    lines.push(
      "",
      zeroBrokerPolicy
        ? "   This failure policy explicitly rejects broker values."
        : "   Compatible per-metric broker values remain eligible.",
      "   Company evidence, formulas and historical inference",
      "   remain subject to forecast-authority and",
      "   workbook-integrity gates.",
    );
  }
  if (confirmationErrors.length > 0) {
    lines.push("", "   OPTIONAL OVERRIDE NOT ACCEPTED");
    for (const error of confirmationErrors.slice(0, 4)) {
      for (const line of indented(error, 3, RULE_WIDTH - 3)) lines.push(line);
    }
  }
  lines.push(
    "",
    "   Full tables, exact source cells and alternates are in",
    "   broker-preview.json. The clean recommendation is accepted",
    "   automatically and cannot promote evidence that the",
    "   checks have set aside.",
    ...(confirmationErrors.length > 0
      ? [
          "",
          "   The automatic clean recommendation remains active.",
          "   No response is required.",
        ]
      : [
          "",
          "   The controller continues automatically into the",
          "   fallback forecast checks and model decisions.",
        ]),
    "",
    `   Preview sealed for this run: ${String(preview?.preview_sha256 ?? "").slice(0, 16)}...`,
    RULE,
  );
  return finishScreen(lines, { summariseOverflow: true });
}

// The welcome screen is reproduced verbatim from the user-flow document. It is a
// constant rather than a template because there is nothing in it to vary: the
// three inputs are fixed by the flow. Internal receipt stages are deliberately
// absent: the user sees only the canonical six-milestone journey.
export const WELCOME_SCREEN = finishScreen([
  ...renderStageHeader("inputs", "action required"),
  "",
  "   DEBT OVERLAY",
  "   Debt, leverage and liquidity - fully formula-driven",
  "",
  "   Three years back, three years forward, built from the",
  "   company's filings, your FactSet debt export and broker",
  "   consensus. Every figure traces to its source.",
  "",
  RULE,
  "   HOW THIS GOES",
  RULE,
  "",
  "   1  Company identified                     <- you are here",
  "   2  Filings read or supplied",
  "   3  Broker research read in one pass",
  "   4  FactSet debt export reconciled",
  "   5  Workbook built and checked              no contact",
  "   6  Model and concise findings delivered",
  "",
  RULE,
  "   WHAT I NEED",
  RULE,
  "",
  "   1   COMPANY NAME",
  "",
  "   2   FACTSET DEBT EXPORT",
  "       Set the date toggle to LAST FISCAL YEAR END before",
  "       exporting - not today's date.",
  "",
  "   3   BROKER RESEARCH             optional, 1 to 10",
  "       Three is the minimum for a meaningful consensus",
  "       for one EBIT/EBITDA anchor plus the D&A bridge.",
  "",
  "   4   CASE FILE FROM LAST TIME                 optional",
  "       Attach it to preserve settled answers on a rebuild.",
  "",
  RULE,
  "   Currency, fiscal calendar and periods follow the company.",
  "   You will not be asked to confirm them.",
  "",
  "   NEXT ACTION",
  "   Provide the company name and input pack.",
  RULE,
]);

// ---------------------------------------------------------------------------
// Constitution frame grammar (v3 SS7): open-right header, six-chip progress
// rail, dot leaders, REPLY band. Every screen built here passes the same
// render-time gate (printable ASCII, width cap, line cap) as the rest.
// ---------------------------------------------------------------------------

export const RAIL_CHIPS = Object.freeze(
  VISIBLE_MILESTONES.map((item) => item.label),
);

function frameTop(title) {
  const left = "+=[ EXCEL INFLOW ]";
  const right = `[ ${asciiText(title).toUpperCase()} ]=+`;
  const fill = RULE_WIDTH - left.length - right.length;
  return `${left}${"=".repeat(Math.max(2, fill))}${right}`;
}

function frameBottom() {
  return `+${"=".repeat(RULE_WIDTH - 1)}`;
}

function replyBand() {
  const label = "+--[ REPLY ]";
  return `${label}${"-".repeat(Math.max(2, RULE_WIDTH - label.length))}`;
}

// states: map chip name -> "done" | "active" | "blocked" | pending (absent)
export function renderRail(states = {}) {
  const MARK = { done: "x", active: ">", blocked: "!" };
  const chips = RAIL_CHIPS.map((chip) => {
    const mark = MARK[states[chip]] ?? " ";
    return `[${mark}]${chip}`;
  });
  // Two lines of three chips each keeps the rail inside the width cap.
  return [
    `|  ${chips.slice(0, 3).join("  ")}`,
    `|  ${chips.slice(3).join("  ")}`,
  ];
}

function body(text = "") {
  return text === "" ? "|" : `|  ${text}`;
}

export function framedScreen({ title, states, lines, reply = null }) {
  const out = [frameTop(title), "|", ...renderRail(states), "|"];
  for (const line of lines) out.push(body(line));
  if (reply) {
    out.push(replyBand(), "|");
    for (const line of reply) out.push(`|     > ${line}`);
    out.push("|");
  }
  out.push(frameBottom());
  return finishScreen(out);
}

// S1 - COMPANY. The entry screen asks for the company and NOTHING else: the
// filings lane auto-pulls where the runtime carries access, broker research
// is collected at the BROKERS stage and the FactSet export at the DEBT
// stage. The fast path (everything supplied up front) is stated, not
// demanded.
export const COMPANY_RUNTIME_MODES = Object.freeze([
  "DEVELOPMENT_SOURCE",
  "INSTALLED_CANDIDATE",
  "PRODUCTION_ACTIVE",
]);

export const COMPANY_SCREEN_SESSION_CONTRACT = Object.freeze({
  schema_version: "excel-inflow-company-screen-contract/1.0",
  runtime_modes: COMPANY_RUNTIME_MODES,
  mode_markers: Object.freeze({
    DEVELOPMENT_SOURCE: "DEVELOPMENT SOURCE · NOT INSTALLED",
    INSTALLED_CANDIDATE: "CANDIDATE SLOT · NOT ACTIVE",
    PRODUCTION_ACTIVE: null,
  }),
  host_marker_prefix: "HOST READY · SESSION ",
  nonce_pattern: "^[A-F0-9]{6}$",
});

export const COMPANY_SCREEN_SESSION_CONTRACT_SHA256 = createHash("sha256")
  .update(JSON.stringify(COMPANY_SCREEN_SESSION_CONTRACT))
  .digest("hex");

export function renderCompanyScreen({ runtimeMode, screenNonce }) {
  if (!COMPANY_RUNTIME_MODES.includes(runtimeMode)) {
    throw new Error(`Company screen requires one derived runtime mode; got ${runtimeMode}.`);
  }
  if (!/^[A-F0-9]{6}$/.test(String(screenNonce ?? ""))) {
    throw new Error("Company screen requires one six-character uppercase hexadecimal session nonce.");
  }
  const modeMarker = COMPANY_SCREEN_SESSION_CONTRACT.mode_markers[runtimeMode];
  return framedScreen({
    title: "COMPANY",
    states: { Company: "active" },
    lines: [
    ...(modeMarker ? [modeMarker, ""] : []),
    `${COMPANY_SCREEN_SESSION_CONTRACT.host_marker_prefix}${screenNonce}`,
    "",
    "DEBT OVERLAY",
    "Debt, leverage and liquidity - fully formula-driven.",
    "Three years back, three years forward. Every figure",
    "traces to its source.",
    "",
    "Name the company. Nothing else is needed yet.",
    "",
    "Filings ............ pulled for you where the runtime",
    "                     has access; attach 3 full years",
    "                     to override",
    "Broker research .... requested at Brokers",
    "FactSet export ..... requested at Debt",
    "",
    "Attach everything now if you prefer - the flow then",
    "stops only for a genuine model decision, if one remains.",
    "",
    "Currency, fiscal calendar and periods follow the",
    "company. You will not be asked to confirm them.",
    ],
    reply: ["company name (e.g. AstraZeneca)"],
  });
}

// The Brokers milestone is an explicit upload-or-skip checkpoint. Broker
// evidence is optional, but absence is not consent to skip it. This screen is
// therefore ACTION REQUIRED and must never be paired with "no response is
// required" wording.
export function renderBrokerIntakeScreen(issuerName = "the company") {
  return framedScreen({
    title: "BROKERS",
    states: { Company: "done", Filings: "done", Brokers: "active" },
    lines: [
      String(issuerName),
      "",
      "STATUS: ACTION REQUIRED",
      "",
      "BROKER RESEARCH - CHOOSE ONE PATH",
      "",
      "Attach 1 to 10 broker reports now. PDF is preferred,",
      "with one report per house where possible.",
      "",
      "The reports improve forecast authority but are optional.",
      "Extraction, OCR and reconciliation stay internal. Any",
      "single unusable number is dropped, never guessed at;",
      "it does not stop the model.",
      "",
      "Or continue with company evidence and historical drivers.",
      "Missing files never count as a decision to skip.",
    ],
    reply: [
      "attach 1-10 broker reports",
      "or type exactly: continue without brokers",
    ],
  });
}

// The three stage-1 inputs, in the order the welcome screen presents them, so a
// caller can drive intake off the same declaration the screen is rendered from
// rather than off a second hand-written list.
export const REQUIRED_INPUTS = Object.freeze([
  Object.freeze({
    ordinal: 1,
    id: "company_name",
    label: "COMPANY NAME",
    kind: "text",
  }),
  Object.freeze({
    ordinal: 2,
    id: "debt_export",
    label: "FACTSET DEBT EXPORT",
    kind: "upload",
    // The commonest production error by a distance: an export taken at today's
    // date instead of the last fiscal year end reconciles against nothing and
    // presents as a large unexplained residual.
    warning:
      "Set the FactSet date toggle to LAST FISCAL YEAR END before exporting - not today's date.",
  }),
  Object.freeze({
    ordinal: 3,
    id: "broker_research",
    label: "BROKER RESEARCH",
    kind: "upload_set",
    minimum: 1,
    maximum: 10,
  }),
]);

export const OPTIONAL_INPUTS = Object.freeze([
  Object.freeze({
    ordinal: 4,
    id: "prior_case",
    label: "CASE FILE FROM LAST TIME",
    kind: "upload",
    purpose:
      "Preserve settled stage-3 answers and evidence decisions without relying on sandbox persistence.",
  }),
]);

function codePoints(text) {
  return [...String(text)];
}

export function displayWidth(text) {
  return codePoints(text).length;
}

function padEnd(text, width) {
  const pad = width - displayWidth(text);
  return pad > 0 ? `${text}${" ".repeat(pad)}` : text;
}

function padStart(text, width) {
  const pad = width - displayWidth(text);
  return pad > 0 ? `${" ".repeat(pad)}${text}` : text;
}

// Greedy wrap on spaces. A single token longer than the budget is emitted whole
// rather than hyphenated, because the tokens that get long here are instrument
// names and breaking one makes it unsearchable.
export function wrap(text, width) {
  const rawWords = asciiText(text).split(/\s+/).filter(Boolean);
  const words = rawWords.flatMap((word) => {
    if (displayWidth(word) <= width) return [word];
    const pieces = [];
    for (let index = 0; index < word.length; index += width) {
      pieces.push(word.slice(index, index + width));
    }
    return pieces;
  });
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line === "") {
      line = word;
      continue;
    }
    if (displayWidth(line) + 1 + displayWidth(word) <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
}

function indented(text, indent, width) {
  return wrap(text, width).map((line) => `${" ".repeat(indent)}${line}`);
}

const CURRENCY_SYMBOLS = Object.freeze({
  EUR: "EUR ",
  USD: "USD ",
  GBP: "GBP ",
  JPY: "JPY ",
  CHF: "CHF ",
  SEK: "SEK ",
  NOK: "NOK ",
  DKK: "DKK ",
  CAD: "C$",
  AUD: "A$",
});

export function currencySymbol(currency) {
  const code = String(currency ?? "").toUpperCase();
  return CURRENCY_SYMBOLS[code] ?? (code ? `${code} ` : "");
}

// Money as a reader says it. The case unit is millions throughout, so a value of
// 400 is "€400m" and 1,200 is "€1.2bn". Anything below a million is stated in
// millions to one decimal rather than promoted to thousands, because the model
// has no sub-million precision to justify it.
export function formatMoney(value, currency, { units = "millions" } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "n/a";
  }
  const symbol = currencySymbol(currency);
  const raw = Number(value);
  const sign = raw < 0 ? "-" : "";
  const magnitude = Math.abs(raw);
  if (units !== "millions") {
    return `${sign}${symbol}${formatNumber(magnitude)}`;
  }
  if (magnitude >= 1000) {
    const billions = magnitude / 1000;
    const text = billions >= 100 ? billions.toFixed(0) : billions.toFixed(1);
    return `${sign}${symbol}${stripTrailingZero(text)}bn`;
  }
  if (magnitude >= 10) {
    return `${sign}${symbol}${magnitude.toFixed(0)}m`;
  }
  return `${sign}${symbol}${stripTrailingZero(magnitude.toFixed(1))}m`;
}

function stripTrailingZero(text) {
  return text.replace(/\.0$/, "");
}

// Plain grouped integer, used by the reconciliation screen, which states the
// three numbers in model units with no currency symbol exactly as the user-flow
// document shows them.
export function formatNumber(value, { decimals = 0 } = {}) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return "n/a";
  const fixed = Math.abs(raw).toFixed(decimals);
  const [whole, fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = raw < 0 ? "-" : "";
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

export function formatTurns(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "n/a";
  }
  return `${Number(value).toFixed(1)}x`;
}

// ── stage 3 ────────────────────────────────────────────────────────────────

// The question screen. `questions` is the already-pruned, already-capped list
// produced by flow_questions.mjs; this function never drops or reorders one.
export function renderQuestionScreen(questions) {
  const count = questions.length;
  const heading = `   ${count} QUESTION${count === 1 ? "" : "S"} BEFORE BUILD`;
  const lines = [
    ...renderStageHeader("decisions", "action required"),
    "",
    heading,
    "",
  ];
  questions.forEach((question, index) => {
    if (index > 0) lines.push("", "");
    const prefix = `   ${index + 1}   `;
    const body = wrap(question.prompt, RULE_WIDTH - prefix.length);
    lines.push(`${prefix}${body[0]}`);
    for (const line of body.slice(1)) {
      lines.push(`${" ".repeat(prefix.length)}${line}`);
    }
    if (question.consequence) {
      for (const line of indented(
        question.consequence,
        prefix.length,
        RULE_WIDTH - prefix.length,
      )) {
        lines.push(line);
      }
    }
  });
  // The screen is the RECEIPT; the native question cards are the decision
  // instrument.  Option lists live on the cards (toQuestionCards), not in
  // ASCII.  Free text remains only for attachments and issue-raising.
  lines.push("", "   Answer the question cards below.", "", RULE);
  return finishScreen(lines);
}

// What the user types back. Rendered so the fixtures can assert the contract the
// answer parser accepts, and so the screen and the parser cannot drift.
export function renderAnswerTemplate(questions) {
  return questions
    .map((question, index) => `${index + 1}, ${question.options[0].word}`)
    .join("\n");
}

// `1, yes` / `2, no`. Tolerant of extra whitespace, a trailing full stop, a
// colon instead of a comma and any letter case, because those are what people
// actually type; intolerant of anything that is not one of the declared option
// words, because a mis-parsed answer is worse than a rejected one.
export function parseAnswers(input, questions) {
  const answers = new Map();
  const errors = [];
  const lines = String(input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = /^(\d+)\s*[,:.)]\s*(.+?)[.\s]*$/.exec(line);
    if (!match) {
      errors.push(`Could not read "${line}". Answer as: 1, yes`);
      continue;
    }
    const ordinal = Number(match[1]);
    const word = match[2].trim().toLowerCase();
    const question = questions[ordinal - 1];
    if (!question) {
      errors.push(`There is no question ${ordinal}.`);
      continue;
    }
    const option = question.options.find(
      (candidate) => candidate.word.toLowerCase() === word,
    );
    if (!option) {
      errors.push(
        `Question ${ordinal} takes ${question.options
          .map((candidate) => candidate.word)
          .join(" or ")}, not "${match[2].trim()}".`,
      );
      continue;
    }
    answers.set(question.id, option.id);
  }
  for (const [index, question] of questions.entries()) {
    if (!answers.has(question.id)) {
      errors.push(`Question ${index + 1} is unanswered.`);
    }
  }
  return { answers, errors, complete: errors.length === 0 };
}

function forecastMethodLabel(authority) {
  if (authority.method === "not_separately_forecast") return "captured by parent";
  if (authority.method === "actual_plus_remainder") return "actual + remainder";
  return String(authority.method ?? "unresolved").replaceAll("_", " ");
}

function forecastAuthorityValue(authority) {
  const value = Number.isFinite(Number(authority.broker_value))
    ? Number(authority.broker_value)
    : Number.isFinite(Number(authority.value))
      ? Number(authority.value)
      : null;
  return value === null ? "" : ` = ${formatNumber(value, { decimals: 1 })}`;
}

/**
 * Stage 3 always exposes the economic forecast decisions before a workbook is
 * built.  Formula totals and schedule links are deliberately omitted from the
 * list: they calculate.  The screen is about the independent assumptions a
 * reader needs to challenge -- guidance, brokers, run-rate, trend, flatline,
 * explicit zero and parent-captured detail.
 */
export function renderForecastPlanScreen(modelCase, sealedPlan = null) {
  if (sealedPlan?.schema_version === "forecast-plan/2.0") {
    const independent = sealedPlan.states.filter((state) =>
      !["formula", "schedule"].includes(state.producer_type) ||
      state.status === "BLOCKED",
    );
    const lines = [
      ...renderStageHeader(
        "decisions",
        sealedPlan.status === "PASS" ? "complete - review before build" : "blocked",
      ),
      "",
      sealedPlan.status === "PASS"
        ? "   MATERIAL FORECAST PLAN"
        : "   MATERIAL FORECAST EVIDENCE REQUIRED",
      "",
    ];
    for (const state of independent) {
      const row = [
        ...(modelCase?.statement_structure?.income_statement ?? []),
        ...(modelCase?.statement_structure?.cash_flow ?? []),
      ].find((candidate) => candidate.row_id === state.row_id);
      const value = Number.isFinite(Number(state.value))
        ? ` = ${formatNumber(Number(state.value), { decimals: 1 })}`
        : "";
      const detail = `${String(state.period_end).slice(0, 4)}: ${forecastMethodLabel(state)}${value}`;
      const labelLines = wrap(String(row?.label ?? state.row_id), RULE_WIDTH - 3);
      lines.push(`   ${labelLines[0]}`);
      for (const part of labelLines.slice(1)) lines.push(`   ${part}`);
      for (const part of wrap(detail, RULE_WIDTH - 6)) lines.push(`      ${part}`);
      if (state.status === "BLOCKED") {
        for (const part of wrap(state.rationale, RULE_WIDTH - 6)) lines.push(`      ${part}`);
      }
    }
    lines.push("");
    for (const part of wrap(
      sealedPlan.status === "PASS"
        ? `${independent.length} independent/captured state(s); totals and schedules calculate.`
        : `${sealedPlan.unresolved_material_count} material state(s) must be resolved before build.`,
      RULE_WIDTH - 3,
    )) lines.push(`   ${part}`);
    for (const part of wrap(
      sealedPlan.status === "PASS"
        ? "The controller continues automatically into Build."
        : "Supply a compatible source or explicit assumption; no workbook has been built.",
      RULE_WIDTH - 3,
    )) lines.push(`   ${part}`);
    lines.push("", RULE);
    return finishScreen(lines, { summariseOverflow: true });
  }
  const rows = [
    ...(modelCase?.statement_structure?.income_statement ?? []),
    ...(modelCase?.statement_structure?.cash_flow ?? []),
  ];
  const selected = rows.filter((row) => {
    if (row.row_type === "header") return false;
    const authorities = [0, 1, 2].map((index) =>
      resolveForecastAuthority(modelCase, row, index),
    );
    const independent = authorities.some((authority) =>
      ["broker", "hardcode", "zero", "uncalculated", "block"].includes(
        authority.mechanism,
      ),
    );
    const material = authorities.some((authority) => authority.material === true) ||
      forecastRowMateriality(modelCase, row) === true;
    return independent && material;
  });

  const lines = [
    ...renderStageHeader("decisions", "complete - review before build"),
    "",
    "   MATERIAL FORECAST PLAN",
    "",
  ];
  for (const row of selected) {
    const rowLabel = wrap(String(row.label), RULE_WIDTH - 3);
    lines.push(`   ${rowLabel[0]}`);
    for (const continuation of rowLabel.slice(1)) {
      lines.push(`   ${continuation}`);
    }
    [0, 1, 2].forEach((index) => {
      const authority = resolveForecastAuthority(modelCase, row, index);
      const period = String(
        modelCase.periods?.[index + 3]?.date ?? `FY${index + 1}`,
      ).slice(0, 4);
      const source = authority.source_id
        ? ` [${authority.source_id}]`
        : authority.method === "broker_consensus"
          ? " [broker pack]"
          : row.parent_row_id && authority.method === "not_separately_forecast"
            ? ` [${row.parent_row_id}]`
            : "";
      const detail =
        `${period}: ${forecastMethodLabel(authority)}` +
        `${forecastAuthorityValue(authority)}${source}`;
      const wrapped = wrap(detail, RULE_WIDTH - 6);
      lines.push(`      ${wrapped[0]}`);
      for (const continuation of wrapped.slice(1)) {
        lines.push(`      ${continuation}`);
      }
    });
  }
  if (selected.length === 0) {
    lines.push("   No material independent forecast assumptions resolved.");
  }
  lines.push("");
  lines.push(...indented(
    `${selected.length} material independent row(s).`,
    3,
    RULE_WIDTH - 3,
  ));
  lines.push(
    "   Forecast totals and links calculate.",
    "   The controller continues automatically into Build.",
    "",
    RULE,
  );
  return finishScreen(lines, { summariseOverflow: true });
}

// Legacy diagnostic renderer retained for archived receipts. Current runs use
// Retained only for compatibility with archived receipts. Production question
// planning now emits deterministic decision rounds of at most five;
// cardinality alone is never evidence that the source pack is wrong.
export function renderTooManyQuestions(survivors, { limit = 5 } = {}) {
  const lines = [
    ...renderStageHeader("decisions", "blocked"),
    "",
    "   I CANNOT BUILD THIS FROM THE CURRENT INPUT PACK",
    "",
  ];
  for (const line of indented(
    `${survivors.length} things about this company's debt are unresolved and each one ` +
      `moves the answer. That is more than a build should need to ask ` +
      `(the limit is ${limit}), and it means the inputs are thin rather than the ` +
      `company being complicated.`,
    3,
    RULE_WIDTH - 3,
  )) {
    lines.push(line);
  }
  lines.push("", "   What is unresolved:", "");
  survivors.forEach((question, index) => {
    const prefix = `   ${index + 1}   `;
    const body = wrap(question.subject_line, RULE_WIDTH - prefix.length);
    lines.push(`${prefix}${body[0]}`);
    for (const line of body.slice(1)) {
      lines.push(`${" ".repeat(prefix.length)}${line}`);
    }
  });
  lines.push("");
  for (const line of indented(
    "Most likely one of: the export is a summary rather than the full DCS " +
      "debt detail, or it was taken at today's date, or the filings supplied " +
      "cover a different reporting entity.",
    3,
    RULE_WIDTH - 3,
  )) {
    lines.push(line);
  }
  lines.push("", RULE);
  return finishScreen(lines, { summariseOverflow: true });
}

// ── the reconciliation stop ────────────────────────────────────────────────

// Not a question: a re-supply. No answer the user can type fixes a stale export,
// so the two options are "send me a better one" and "build anyway and carry the
// residual on the face of the model".
export function renderReconciliationScreen({
  export_total,
  reported_gross_debt,
  residual,
  fiscal_label,
  diagnosis,
  options,
}) {
  const numbers = [export_total, reported_gross_debt, residual].map((value) =>
    formatNumber(value),
  );
  const labels = [
    "Instruments in your export",
    `Gross debt per ${fiscal_label} accounts`,
    "Unexplained",
  ];
  const numberWidth = Math.max(...numbers.map(displayWidth));
  const labelWidth = Math.max(...labels.map(displayWidth));
  // The document sets this block 42 columns wide: three of indent, the label,
  // then the figure right-aligned to the last column. Widen only if a label or
  // a figure does not fit.
  const totalWidth = Math.max(42, 3 + labelWidth + 3 + numberWidth);
  const row = (label, number) =>
    `   ${label}${padStart(number, totalWidth - 3 - displayWidth(label))}`;
  const lines = [
    ...renderStageHeader("evidence_review", "blocked"),
    "",
    row(labels[0], numbers[0]),
    row(labels[1], numbers[1]),
    `   ${padStart("-".repeat(numberWidth + 1), totalWidth - 3)}`,
    row(labels[2], numbers[2]),
    "",
  ];
  for (const line of indented(diagnosis, 3, RULE_WIDTH - 3)) lines.push(line);
  lines.push("");
  options.forEach((option, index) => {
    const prefix = `     ${index + 1})  `;
    const body = wrap(option, RULE_WIDTH - prefix.length);
    lines.push(`${prefix}${body[0]}`);
    for (const line of body.slice(1)) {
      lines.push(`${" ".repeat(prefix.length)}${line}`);
    }
  });
  lines.push("", RULE);
  return finishScreen(lines);
}

// The entity stop. Presented separately from the reconciliation stop because the
// remedy is different: a post-merger or holdco/opco mismatch produces a gap that
// looks exactly like a date problem, and re-exporting at the year end fixes
// nothing.
export function renderEntityScreen({
  export_entity,
  filing_entity,
  detail,
  options,
}) {
  const lines = [
    ...renderStageHeader("evidence_review", "blocked"),
    "",
    "   THESE ARE NOT THE SAME COMPANY",
    "",
  ];
  const labelWidth = 26;
  lines.push(`   ${padEnd("Your export covers", labelWidth)}${export_entity}`);
  lines.push(`   ${padEnd("The filings cover", labelWidth)}${filing_entity}`);
  lines.push("");
  for (const line of indented(detail, 3, RULE_WIDTH - 3)) lines.push(line);
  lines.push("");
  options.forEach((option, index) => {
    const prefix = `     ${index + 1})  `;
    const body = wrap(option, RULE_WIDTH - prefix.length);
    lines.push(`${prefix}${body[0]}`);
    for (const line of body.slice(1)) {
      lines.push(`${" ".repeat(prefix.length)}${line}`);
    }
  });
  lines.push("", RULE);
  return finishScreen(lines);
}

// ── stage 5 ────────────────────────────────────────────────────────────────

export function renderDeliveryReport(report, { status = "complete" } = {}) {
  const lines = [...renderStageHeader("delivery", status), ""];
  for (const line of indented(report.read, 3, RULE_WIDTH - 3)) lines.push(line);
  lines.push("");
  const section = (title, entries) => {
    if (entries.length === 0) return;
    lines.push(RULE, `   ${title}`, RULE, "");
    for (const entry of entries.slice(0, SCREEN_CONTRACT.max_delivery_findings_per_section)) {
      const body = wrap(entry, RULE_WIDTH - 6);
      lines.push(`   - ${body[0]}`);
      for (const line of body.slice(1)) lines.push(`     ${line}`);
    }
    if (entries.length > SCREEN_CONTRACT.max_delivery_findings_per_section) {
      lines.push(
        `   - ${entries.length - SCREEN_CONTRACT.max_delivery_findings_per_section} more in the delivery receipt`,
      );
    }
    lines.push("");
  };
  section("BUILD IDENTITY", report.build_identity ?? []);
  section("TIES TO THE FILINGS", report.ties);
  section("BROKER SUBSTITUTIONS", report.broker_substitutions ?? []);
  section("FORECAST AUTHORITY", report.forecast_authority_summary ?? []);
  section("TYPED, NOT DERIVED", report.typed);
  section("ASSUMED", report.assumed);
  section("PLAUSIBLE, NOT CONFIRMED", report.plausible_only);
  lines.push(RULE);
  return finishScreen(lines, { summariseOverflow: true });
}

// A failed invariant currently just stops. It has to say what failed and what
// would fix it, or the user is left holding a stack trace.
export function renderFailure({ stage, what_failed, why, what_would_fix_it }) {
  const aliases = {
    intake: "inputs",
    evidence: "evidence_review",
    filings: "evidence_review",
    reconcile: "evidence_review",
    questions: "decisions",
    build: "build_checks",
    delivery: "delivery",
  };
  const stageId = aliases[stage] ?? stage;
  const lines = [
    ...renderStageHeader(stageId, "blocked"),
    "",
    `   STOPPED: ${String(stage).toUpperCase()}`,
    "",
  ];
  for (const line of indented(what_failed, 3, RULE_WIDTH - 3)) lines.push(line);
  if (why) {
    lines.push("");
    for (const line of indented(why, 3, RULE_WIDTH - 3)) lines.push(line);
  }
  lines.push("", "   What would fix it:", "");
  for (const remedy of what_would_fix_it.slice(0, SCREEN_CONTRACT.max_failure_remedies)) {
    const body = wrap(remedy, RULE_WIDTH - 6);
    lines.push(`   - ${body[0]}`);
    for (const line of body.slice(1)) lines.push(`     ${line}`);
  }
  if (what_would_fix_it.length > SCREEN_CONTRACT.max_failure_remedies) {
    lines.push(
      `   - ${what_would_fix_it.length - SCREEN_CONTRACT.max_failure_remedies} more in the run record`,
    );
  }
  lines.push("", RULE);
  return finishScreen(lines, { summariseOverflow: true });
}

export const SCREEN_WIDTH = RULE_WIDTH;

/* ------------------------------------------------------------------ *
 * Case-compile screens (v3): the compile step is the ONLY producer of
 * the model case.  A clean compile passes silently through S6-C; a
 * dirty one stops at S6-X with the COMPLETE findings list — the
 * anti-serial screen.  Facts and compiled rules are not the author's
 * to edit and cannot be wrong independently of the declarations.
 * ------------------------------------------------------------------ */

export function renderCaseCompiledScreen({
  declarations,
  factsProjected,
  rulesMinted,
  caseSourceDigest = null,
  sealedLanes = 3,
}) {
  const digest = caseSourceDigest ? String(caseSourceDigest).slice(0, 8) : null;
  const lines = [
    ...renderStageHeader("delivery", "case compiled"),
    "",
    `   Declarations ........... ${formatNumber(declarations)}${digest ? ` (source ${digest})` : ""}`,
    `   Facts projected ........ ${formatNumber(factsProjected)} from ${formatNumber(sealedLanes)} sealed lanes`,
    `   Compiled rules minted .. ${formatNumber(rulesMinted)} (formula authorities)`,
    "   Findings ............... NONE",
    "",
    "   model-case regenerated deterministically -",
    "   nothing hand-written.",
    "",
    RULE,
  ];
  return finishScreen(lines);
}

export function renderCompileFindingsScreen(report) {
  const blocks = (report?.findings ?? []).filter(
    (finding) => finding.severity === "BLOCK",
  );
  const lines = [
    ...renderStageHeader("delivery", "compile findings"),
    "",
    `   ${blocks.length} finding${blocks.length === 1 ? "" : "s"} - the COMPLETE list, nothing serial:`,
    "",
  ];
  blocks.slice(0, SCREEN_CONTRACT.max_failure_remedies * 2).forEach((finding, index) => {
    const label = `${index + 1}. ${finding.id} `;
    const leader = `   ${label}${".".repeat(Math.max(2, 28 - label.length))}`;
    lines.push(leader.slice(0, RULE_WIDTH - 2));
    for (const line of wrap(finding.message, RULE_WIDTH - 9)) lines.push(`      ${line}`);
    if (finding.remedy) {
      for (const line of wrap(`(${finding.remedy})`, RULE_WIDTH - 9)) lines.push(`      ${line}`);
    }
  });
  if (blocks.length > SCREEN_CONTRACT.max_failure_remedies * 2) {
    lines.push(`   - ${blocks.length - SCREEN_CONTRACT.max_failure_remedies * 2} more in the compile report`);
  }
  lines.push(
    "",
    "   Fix the declarations above; facts and compiled rules",
    "   are not yours to edit and cannot be wrong on their own.",
    "",
    RULE,
  );
  return finishScreen(lines, { summariseOverflow: true });
}

/* ------------------------------------------------------------------ *
 * Native question cards (v3): the ASCII screen is the RECEIPT, the
 * cards are the DECISION instrument.  Each card is one decision with
 * 2-6 enumerated options, the default marked in its label, a one-line
 * evidence context, and a stable question id that maps 1:1 into
 * case-source.answers.  "Skip" records the marked default as a
 * decision (`via: "skip"`), never an absence.
 * ------------------------------------------------------------------ */

export const CARD_CONTRACT = Object.freeze({
  max_cards_per_batch: 4,
  min_options: 2,
  max_options: 6,
});

export function toQuestionCards(questions, { round = "A" } = {}) {
  const cards = questions.map((question, index) => {
    // The card id must be the question's OWN stable id whenever it has one —
    // recorded answers key on it. A synthetic round ordinal is a last resort
    // for fixtures only.
    const id = question.id ?? question.question_id ?? `${round}${index + 1}`;
    // "Skip records the marked default" is a decision contract: the marked
    // option must be the question's declared default_option, never a
    // positional guess. Index 0 is only the fallback when the question
    // declares no default at all.
    const declaredDefault = question.default_option ?? null;
    const hasDeclaredDefault =
      declaredDefault !== null &&
      (question.options ?? []).some(
        (option) => (option.id ?? option.word) === declaredDefault,
      );
    const options = (question.options ?? []).map((option, optionIndex) => {
      const optionId = option.id ?? option.word ?? String(optionIndex + 1);
      const isDefault = hasDeclaredDefault
        ? optionId === declaredDefault
        : Boolean(option.default) || optionIndex === 0;
      return {
        option_id: optionId,
        label:
          (option.label ?? option.word ?? String(optionIndex + 1)) +
          (isDefault ? " (default)" : ""),
        is_default: isDefault,
      };
    });
    if (options.length < CARD_CONTRACT.min_options || options.length > CARD_CONTRACT.max_options) {
      throw new Error(
        `Question ${id} has ${options.length} options; cards carry ${CARD_CONTRACT.min_options}-${CARD_CONTRACT.max_options}.`,
      );
    }
    return {
      question_id: id,
      prompt: asciiText(question.prompt),
      ...(question.consequence ? { context: asciiText(question.consequence) } : {}),
      options,
    };
  });
  // A round is one checkpoint's cards, contiguous: batches of <=4, asked
  // back-to-back at the same checkpoint, never deferred.
  const batches = [];
  for (let index = 0; index < cards.length; index += CARD_CONTRACT.max_cards_per_batch) {
    batches.push(cards.slice(index, index + CARD_CONTRACT.max_cards_per_batch));
  }
  return { round, cards, batches };
}

// Every S6-X finding whose remedy is enumerable ships as a card generated
// from the SAME compile report as the findings screen - one source.
export function compileFindingsToCards(report) {
  const blocks = (report?.findings ?? []).filter(
    (finding) => finding.severity === "BLOCK",
  );
  const questions = [];
  blocks.forEach((finding, index) => {
    const options = Array.isArray(finding.context?.options)
      ? finding.context.options
      : null;
    if (!options || options.length < CARD_CONTRACT.min_options) return;
    questions.push({
      question_id: `X${index + 1}`,
      prompt: `${finding.id}: ${finding.message}`,
      consequence: finding.remedy ?? null,
      options: options.map((label, optionIndex) => ({
        id: `X${index + 1}-${optionIndex + 1}`,
        label,
        default: optionIndex === 0,
      })),
    });
  });
  return toQuestionCards(questions, { round: "X" });
}

// The closing band of every checkpoint screen once cards carry decisions.
export const ANSWER_CARDS_BAND = "   Answer the question cards below.";
