// Deterministic statement-line classifier.  It deliberately has no LLM call:
// its job is to make a proposed mapping explainable and to abstain where the
// available source evidence cannot distinguish economic treatments.
import fs from "node:fs";

const TAXONOMY = JSON.parse(fs.readFileSync(
  new URL("../../assets/statement-semantic-taxonomy.v1.json", import.meta.url), "utf8",
));

function normalise(value) {
  return String(value ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function words(value) {
  return new Set(normalise(value).split(" ").filter(Boolean));
}

function phraseMatch(label, phrase) {
  // An alias is a complete disclosure label, not a substring. Otherwise the
  // word "revenue" makes "cost of revenue" look equally like top-line sales.
  return normalise(label) === normalise(phrase);
}

function contextText(line) {
  return [line.parent_label, ...(line.neighbouring_labels ?? []), line.table_context]
    .filter(Boolean).join(" ");
}

function candidateFor(role, line) {
  const label = normalise(line.label);
  const labelWords = words(label);
  const context = contextText(line);
  const evidence = [];
  let score = 0;
  const exact = role.aliases.some((alias) => phraseMatch(label, alias));
  if (exact) {
    score += 0.65;
    evidence.push({ channel: "label", detail: "declared alias", score: 0.65 });
  } else {
    const matches = role.tokens.filter((token) => labelWords.has(normalise(token)));
    if (matches.length > 0) {
      const tokenScore = Math.min(0.42, matches.length * 0.14);
      score += tokenScore;
      evidence.push({ channel: "label", detail: `tokens: ${matches.join(", ")}`, score: tokenScore });
    }
  }
  if (role.negative_tokens?.some((token) => labelWords.has(normalise(token)))) {
    score -= 0.5;
    evidence.push({ channel: "negative", detail: "excluded label token", score: -0.5 });
  }
  if (role.sections.includes(line.section)) {
    score += 0.2;
    evidence.push({ channel: "context", detail: `statement: ${line.section}`, score: 0.2 });
  } else {
    score -= 0.35;
    evidence.push({ channel: "context", detail: `wrong statement: ${line.section}`, score: -0.35 });
  }
  const contextWords = words(context);
  const contextMatches = role.tokens.filter((token) => contextWords.has(normalise(token)));
  if (contextMatches.length > 0) {
    score += 0.12;
    evidence.push({ channel: "hierarchy", detail: `context tokens: ${contextMatches.join(", ")}`, score: 0.12 });
  }
  return { role: role.id, score: Math.max(0, Math.min(1, score)), evidence, high_impact: role.high_impact };
}

/**
 * Return an accepted classification only when evidence clears an explicit
 * threshold. `ambiguous` and `unmapped` are valid, intentional outcomes.
 */
export function classifyStatementLine(line) {
  if (!line?.label || !line?.section) {
    throw new Error("Statement classification requires a label and statement section.");
  }
  const candidates = TAXONOMY.roles
    .map((role) => candidateFor(role, line))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));
  const best = candidates[0] ?? null;
  const next = candidates[1] ?? null;
  if (!best || best.score < 0.6) {
    return { taxonomy_version: TAXONOMY.contract_version, status: "unmapped", classified_role: null, confidence: 0, evidence: [], candidates: candidates.map(({ role, score }) => ({ role, score: Number(score.toFixed(2)) })) };
  }
  const channels = new Set(best.evidence.filter((item) => item.score > 0).map((item) => item.channel));
  const separated = !next || best.score - next.score >= 0.15;
  const sufficientlySupported = !best.high_impact || channels.size >= 2;
  const accepted = best.score >= 0.85 && separated && sufficientlySupported;
  return {
    taxonomy_version: TAXONOMY.contract_version,
    status: accepted ? "accepted" : "ambiguous",
    classified_role: accepted ? best.role : null,
    confidence: Number(best.score.toFixed(2)),
    evidence: best.evidence,
    candidates: candidates.map(({ role, score }) => ({ role, score: Number(score.toFixed(2)) })),
  };
}

export function isHighImpactRole(role) {
  return TAXONOMY.roles.some((entry) => entry.id === role && entry.high_impact);
}

function roleLabel(role) {
  return String(role ?? "other treatment").replaceAll("_", " ");
}

/**
 * Produce only the material ambiguities that can change cash, debt, interest,
 * tax, leases, FX or an operating subtotal.  These are presented together at
 * the one permitted clarification stop; they are never silently defaulted.
 */
export function planStatementClassificationQuestions(modelCase) {
  const coverage = modelCase?.source_coverage ?? {};
  const questions = [];
  for (const section of ["income_statement", "cash_flow"]) {
    for (const disclosure of coverage[section] ?? []) {
      if (["accepted", "manual_reviewed"].includes(disclosure.classification_status)) continue;
      const classification = classifyStatementLine({ ...disclosure, section });
      const materialOrHighImpact = disclosure.material === true ||
        classification.candidates.some((candidate) => isHighImpactRole(candidate.role));
      if (!materialOrHighImpact || classification.status === "accepted") continue;
      const candidates = classification.candidates.slice(0, 3).map((candidate) => ({
        role: candidate.role,
        label: roleLabel(candidate.role),
        confidence: candidate.score,
      }));
      questions.push({
        id: `statement-classification.${disclosure.source_line_id ?? "missing"}`,
        source_line_id: disclosure.source_line_id ?? null,
        source_label: disclosure.label ?? disclosure.source_line_id ?? "unnamed disclosure",
        section,
        prompt: `How should “${disclosure.label ?? disclosure.source_line_id ?? "this disclosure"}” in the ${roleLabel(section)} be treated?`,
        candidates,
        reason: classification.status === "unmapped"
          ? "The available evidence does not support a material economic classification."
          : "The available evidence supports more than one material economic treatment.",
        resolution_required: true,
      });
    }
  }
  return questions;
}
