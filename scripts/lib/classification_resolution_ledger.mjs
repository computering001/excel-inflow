import { canonicalJson, hashValue } from './run_store.mjs';

/**
 * Classification-resolution ledger (mirrors forecast_authority_ledger.mjs):
 * every statement-line classification reaches a terminal state through a
 * ledger row that records WHO resolved it (resolver_id), the evidence basis,
 * and a grounded rationale — or stays open as a QUESTION row that carries the
 * question itself. A resolution without a resolver, evidence and rationale is
 * a ledger violation, never a silent pass; genuine ambiguity is never
 * auto-stamped into manual_reviewed.
 */
export const CLASSIFICATION_RESOLUTION_LEDGER_VERSION = 'classification-resolution-ledger/1.0';

export const CLASSIFICATION_RESOLUTIONS = Object.freeze([
  'classifier_accepted',
  'declared_role',
  'mapping_representation',
  'unresolved_question',
]);

/**
 * evidence_v1 projection strings. These are the CONTRACT wording the coverage
 * disclosure carries (frozen by the certification cohort); they are never the
 * ledger's rationale — the ledger row records the actual resolver, evidence
 * and a grounded rationale behind each stamp.
 */
export const DECLARED_ROLE_PROJECTION_REASON = 'Role confirmed by statement_map declaration.';
export const MAPPING_PROJECTION_REASON =
  'The disclosed line is represented through the identified visible model rows.';

function classifierEvidence(classification) {
  const evidence = (classification?.evidence ?? [])
    .map((item) => ({
      channel: `classifier:${item?.channel ?? 'unknown'}`,
      detail: String(item?.detail ?? ''),
    }))
    .filter((item) => item.detail !== '');
  if (evidence.length > 0) return evidence;
  const candidates = (classification?.candidates ?? [])
    .slice(0, 3)
    .map((candidate) => `${candidate.role} (${candidate.score})`)
    .join(', ');
  return [{
    channel: 'classifier:candidates',
    detail: candidates
      ? `taxonomy candidates below acceptance: ${candidates}`
      : 'no taxonomy candidate cleared zero',
  }];
}

function questionFor({ section, disclosure, classification }) {
  const label = disclosure?.label ?? disclosure?.source_line_id ?? 'this disclosure';
  return {
    id: `statement-classification.${disclosure?.source_line_id ?? 'missing'}`,
    prompt: `How should “${label}” in the ${String(section).replaceAll('_', ' ')} be treated?`,
    candidates: (classification?.candidates ?? []).slice(0, 3).map((candidate) => ({
      role: candidate.role,
      score: candidate.score,
    })),
  };
}

/**
 * The independent resolver: given one coverage disclosure, the classifier's
 * full verdict and the authored declaration (if any), decide the terminal
 * resolution and the evidence_v1 projection the disclosure carries. The
 * compiler applies the projection verbatim; the ledger row is the authority
 * behind it.
 */
export function resolveClassificationEntry({ section, disclosure, classification, declaredRole }) {
  const sourceLineId = disclosure?.source_line_id ?? '(missing-source-line-id)';
  const label = disclosure?.label ?? sourceLineId;
  const mappedRowIds = (disclosure?.mapped_row_ids ?? []).map(String);
  const common = {
    section,
    source_line_id: sourceLineId,
    label,
    declared_role: declaredRole ?? null,
    classifier_status: classification?.status ?? 'unmapped',
    classifier_role: classification?.classified_role ?? null,
    classifier_version: `statement-taxonomy/${classification?.taxonomy_version ?? 'unknown'}`,
    mapped_row_ids: mappedRowIds,
  };

  if (
    classification?.status === 'accepted' &&
    (!declaredRole || declaredRole === classification.classified_role)
  ) {
    return {
      entry: {
        ...common,
        resolution: 'classifier_accepted',
        resolver_id: common.classifier_version,
        resolver_kind: 'independent_classifier',
        classified_role: classification.classified_role,
        evidence_basis: classifierEvidence(classification),
        rationale:
          `The statement classifier (${common.classifier_version}) accepted role ` +
          `${classification.classified_role} for ${section}.${sourceLineId} at confidence ` +
          `${classification.confidence}${declaredRole ? ', agreeing with the authored declaration' : ''}.`,
        question: null,
        status: 'PASS',
      },
      projection: {
        classification_status: 'accepted',
        classification_review_status: 'auto_accepted',
        classified_role: classification.classified_role,
      },
    };
  }

  if (declaredRole) {
    const conflict =
      classification?.status === 'accepted' && classification.classified_role !== declaredRole;
    return {
      entry: {
        ...common,
        resolution: 'declared_role',
        resolver_id: `statement_map.${section}.${sourceLineId}.role`,
        resolver_kind: 'authored_declaration',
        classified_role: declaredRole,
        evidence_basis: [
          {
            channel: 'statement_map:role',
            detail: `role ${declaredRole} declared on the ${section} statement_map entry for ${sourceLineId}`,
          },
          {
            channel: conflict ? 'classifier:conflict' : 'classifier:verdict',
            detail: conflict
              ? `classifier accepted ${classification.classified_role} instead; the authored declaration wins and the disagreement is recorded here`
              : `classifier verdict ${common.classifier_status}` +
                (common.classifier_role ? ` (${common.classifier_role})` : ''),
          },
        ],
        rationale:
          `Role ${declaredRole} for ${section}.${sourceLineId} (“${label}”) is resolved by the case ` +
          `author's statement_map role declaration; the classifier's verdict is preserved as evidence, ` +
          `not adopted.`,
        question: null,
        status: 'PASS',
      },
      projection: {
        classification_status: 'manual_reviewed',
        classification_review_status: 'reviewed',
        classified_role: declaredRole,
        reason: DECLARED_ROLE_PROJECTION_REASON,
      },
    };
  }

  if (mappedRowIds.length > 0) {
    return {
      entry: {
        ...common,
        resolution: 'mapping_representation',
        resolver_id: `statement_map.${section}.${sourceLineId}.disposition`,
        resolver_kind: 'authored_mapping',
        classified_role: classification?.classified_role ?? null,
        evidence_basis: [
          {
            channel: 'statement_map:mapping',
            detail:
              `the authored ${disclosure?.disposition ?? 'mapped'} disposition binds ${sourceLineId} ` +
              `to visible model row(s) ${mappedRowIds.join(', ')}`,
          },
          ...classifierEvidence(classification),
        ],
        rationale:
          `Filed line ${section}.${sourceLineId} (“${label}”) is represented by model row(s) ` +
          `${mappedRowIds.join(', ')} through the case author's statement_map mapping; no semantic role ` +
          `is asserted beyond that representation.`,
        question: null,
        status: 'PASS',
      },
      projection: {
        classification_status: 'manual_reviewed',
        classification_review_status: 'reviewed',
        classified_role: classification?.classified_role ?? null,
        reason: MAPPING_PROJECTION_REASON,
      },
    };
  }

  // Genuine ambiguity: no accepted classification, no authored role, and no
  // visible model-row representation. There is no resolver — the question is
  // the terminal state until a person answers it.
  const status = ['ambiguous', 'unmapped'].includes(classification?.status)
    ? classification.status
    : 'unmapped';
  return {
    entry: {
      ...common,
      resolution: 'unresolved_question',
      resolver_id: null,
      resolver_kind: null,
      classified_role: null,
      evidence_basis: classifierEvidence(classification),
      rationale: null,
      question: questionFor({ section, disclosure, classification }),
      status: 'QUESTION',
    },
    projection: {
      classification_status: status,
      classification_review_status: 'needs_question',
      classified_role: null,
    },
  };
}

function normalizeRow(entry) {
  return {
    section: entry?.section ?? null,
    source_line_id: entry?.source_line_id ?? null,
    label: entry?.label ?? null,
    resolution: entry?.resolution ?? null,
    resolver_id: entry?.resolver_id ?? null,
    resolver_kind: entry?.resolver_kind ?? null,
    declared_role: entry?.declared_role ?? null,
    classifier_status: entry?.classifier_status ?? null,
    classifier_role: entry?.classifier_role ?? null,
    classifier_version: entry?.classifier_version ?? null,
    mapped_row_ids: (entry?.mapped_row_ids ?? []).map(String),
    classified_role: entry?.classified_role ?? null,
    evidence_basis: (entry?.evidence_basis ?? []).map((item) => ({
      channel: item?.channel ?? null,
      detail: item?.detail ?? null,
    })),
    rationale: entry?.rationale ?? null,
    question: entry?.question
      ? {
          id: entry.question.id ?? null,
          prompt: entry.question.prompt ?? null,
          candidates: (entry.question.candidates ?? []).map((candidate) => ({
            role: candidate?.role ?? null,
            score: candidate?.score ?? null,
          })),
        }
      : null,
    status: entry?.status ?? null,
  };
}

function rowViolations(row) {
  const id = `${row.section}.${row.source_line_id}`;
  const violations = [];
  if (!CLASSIFICATION_RESOLUTIONS.includes(row.resolution)) {
    violations.push(`${id}: resolution ${row.resolution} is not in the closed vocabulary`);
    return violations;
  }
  if (row.resolution === 'unresolved_question') {
    if (row.resolver_id !== null) {
      violations.push(`${id}: an open question must not name a resolver`);
    }
    if (typeof row.question?.prompt !== 'string' || row.question.prompt.trim() === '') {
      violations.push(`${id}: an open question must carry the question itself`);
    }
    if (row.status !== 'QUESTION') {
      violations.push(`${id}: an unresolved classification must be sealed as QUESTION, not ${row.status}`);
    }
    return violations;
  }
  if (typeof row.resolver_id !== 'string' || row.resolver_id.trim() === '') {
    violations.push(`${id}: a resolved classification must record WHO resolved it (resolver_id)`);
  }
  if (!Array.isArray(row.evidence_basis) || row.evidence_basis.length === 0) {
    violations.push(`${id}: a resolved classification must record its evidence basis`);
  }
  if (typeof row.rationale !== 'string' || row.rationale.trim() === '') {
    violations.push(`${id}: a resolved classification must record a grounded rationale`);
  }
  if (
    row.rationale === DECLARED_ROLE_PROJECTION_REASON ||
    row.rationale === MAPPING_PROJECTION_REASON
  ) {
    violations.push(`${id}: the projection contract string is not a rationale`);
  }
  if (row.status !== 'PASS') {
    violations.push(`${id}: a resolved classification seals as PASS, received ${row.status}`);
  }
  return violations;
}

function ledgerBody(entries, { case_id = null } = {}) {
  const rows = (entries ?? []).map(normalizeRow);
  rows.sort((a, b) =>
    `${a.section} ${a.source_line_id}`.localeCompare(`${b.section} ${b.source_line_id}`),
  );
  const violations = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.section} ${row.source_line_id}`;
    if (seen.has(key)) {
      violations.push(`${row.section}.${row.source_line_id}: duplicate ledger row`);
    }
    seen.add(key);
    violations.push(...rowViolations(row));
  }
  const questions = rows
    .filter((row) => row.status === 'QUESTION')
    .map((row) => ({
      section: row.section,
      source_line_id: row.source_line_id,
      prompt: row.question?.prompt ?? null,
    }));
  return {
    schema_version: CLASSIFICATION_RESOLUTION_LEDGER_VERSION,
    case_id,
    status: violations.length ? 'BLOCK' : questions.length ? 'QUESTIONS' : 'PASS',
    rows,
    questions,
    violations,
  };
}

export function buildClassificationResolutionLedger(entries, meta = {}) {
  const body = ledgerBody(entries, meta);
  return { ...body, ledger_sha256: hashValue(body) };
}

export function sealClassificationResolutionLedger(entries, meta = {}) {
  return buildClassificationResolutionLedger(entries, meta);
}

export function verifyClassificationResolutionLedger(ledger) {
  if (ledger?.schema_version !== CLASSIFICATION_RESOLUTION_LEDGER_VERSION) {
    throw new Error('classification resolution ledger is absent or has the wrong version');
  }
  const expected = buildClassificationResolutionLedger(ledger.rows, { case_id: ledger.case_id ?? null });
  const { ledger_sha256: actualStoredSha, ...actualBody } = ledger;
  const { ledger_sha256: expectedStoredSha, ...expectedBody } = expected;
  const actualBodySha = hashValue(actualBody);
  const expectedBodySha = hashValue(expectedBody);
  const bodiesMatch = canonicalJson(actualBody) === canonicalJson(expectedBody);
  if (
    actualStoredSha !== actualBodySha ||
    expectedStoredSha !== expectedBodySha ||
    actualBodySha !== expectedBodySha ||
    !bodiesMatch
  ) {
    throw new Error(
      `classification resolution ledger drift: expected ${expected.ledger_sha256}, received ${ledger.ledger_sha256}`,
    );
  }
  return ledger;
}

export default {
  CLASSIFICATION_RESOLUTION_LEDGER_VERSION,
  CLASSIFICATION_RESOLUTIONS,
  resolveClassificationEntry,
  buildClassificationResolutionLedger,
  sealClassificationResolutionLedger,
  verifyClassificationResolutionLedger,
};
