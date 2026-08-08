// The user-facing screens of the Debt Overlay skill.
//
// Everything in this module is a pure function from data to a string. No screen
// reads a file, solves a case or decides anything: the decisions are made in
// flow_questions.mjs, flow_reconcile.mjs and flow_read.mjs, and arrive here as
// already-resolved data. That separation is what lets the fixtures assert on
// decisions without asserting on typography, and on typography without running
// a solver.
//
import { SCREEN_CONTRACT, stageById } from "./flow_runtime.mjs";
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
  [/·/g, "-"],
  [/←/g, "<-"],
  [/→/g, "->"],
  [/⚠/g, "WARNING:"],
]);

export function asciiText(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of ASCII_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text.normalize("NFKD").replace(/[^\x00-\x7F]/g, "?");
}

export function inspectScreen(screen) {
  const rendered = String(screen ?? "");
  const body = rendered.startsWith("```text\n") && rendered.endsWith("\n```")
    ? rendered.slice(8, -4)
    : rendered;
  const lines = body.split("\n");
  const violations = [];
  if (SCREEN_CONTRACT.ascii_only && /[^\x00-\x7F]/.test(body)) {
    violations.push("screen contains non-ASCII characters");
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
  return { ok: violations.length === 0, lines: lines.length, violations };
}

function finishScreen(lines, { summariseOverflow = false } = {}) {
  let clean = lines.map((line) => asciiText(line));
  if (summariseOverflow && clean.length > SCREEN_CONTRACT.max_lines) {
    clean = [
      ...clean.slice(0, SCREEN_CONTRACT.max_lines - 3),
      "",
      "   More detail is preserved in the stage receipt.",
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
  return [
    RULE,
    `   STAGE ${stage.number} OF 5 - ${stage.title}`,
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

// The welcome screen is reproduced verbatim from the user-flow document. It is a
// constant rather than a template because there is nothing in it to vary: the
// three inputs are fixed by the flow and the five stages are fixed by G1.
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
  "   1  Provide the input pack                 <- you are here",
  "   2  Evidence is read and reconciled        no contact",
  "   3  Up to five questions are asked         only stop",
  "   4  The workbook is built and checked      no contact",
  "   5  The model and concise findings arrive",
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
  "   3   BROKER RESEARCH             minimum 3, maximum 10",
  "       Three is the minimum for a meaningful consensus",
  "       for one EBIT/EBITDA anchor plus the D&A bridge.",
  "",
  "   4   CASE FILE FROM LAST TIME                 optional",
  "       Attach it to preserve settled answers on a rebuild.",
  "",
  RULE,
  "   Currency, fiscal calendar and periods follow the company.",
  "   You will not be asked to confirm them.",
  RULE,
]);

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
    minimum: 3,
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
    lines.push("");
    const words = question.options.map((option) => option.word);
    lines.push(`${" ".repeat(11)}${words.join("  /  ")}`);
  });
  lines.push("", RULE);
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
export function renderForecastPlanScreen(modelCase) {
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
  lines.push(
    "",
    `   ${selected.length} material independent row(s); totals and links calculate.`,
    "   Reply continue to build, or amend an assumption first.",
    "",
    RULE,
  );
  return finishScreen(lines, { summariseOverflow: true });
}

// The cap of five is reached by pruning, never by truncation. When more than
// five questions survive the decision graph the inputs are wrong, and saying so
// is the correct output — a wall of thirty questions is not.
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
      `   - ${what_would_fix_it.length - SCREEN_CONTRACT.max_failure_remedies} more in the stage receipt`,
    );
  }
  lines.push("", RULE);
  return finishScreen(lines, { summariseOverflow: true });
}

export const SCREEN_WIDTH = RULE_WIDTH;
