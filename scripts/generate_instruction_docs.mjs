#!/usr/bin/env node
/**
 * generate_instruction_docs.mjs — single-source the instruction docs.
 *
 * SKILL.md is the canonical deployed skill artifact (it carries the YAML
 * frontmatter the skill loader consumes). The other two instruction docs are
 * generated views of its body:
 *
 *   central-instructions.md      <- body verbatim
 *   references/runtime-core.md   <- body with a per-audience H1 override
 *
 * Historical drift disposition (audit mp-N, base 880485c):
 *   - YAML frontmatter (4 lines) exists only in SKILL.md by design -> stripped.
 *   - "# Excel Inflow" vs "# Excel Inflow runtime core": intentional
 *     per-audience heading on the reference doc -> declared transform below.
 *   - 7 stray blank lines after "##" headings in runtime-core.md: accidental
 *     whitespace drift -> dropped; canonical wins.
 *
 * Usage:
 *   node scripts/generate_instruction_docs.mjs          # (re)generate both files
 *   node scripts/generate_instruction_docs.mjs --check  # exit 1 if disk differs
 *
 * Output is byte-deterministic: it depends only on SKILL.md's bytes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL = 'SKILL.md';

export const GENERATED_DOC_BANNER_BEGIN = '<!-- generated-document:instruction-mirror/1.0 BEGIN -->';
export const GENERATED_DOC_BANNER_END = '<!-- generated-document:instruction-mirror/1.0 END -->';

export function instructionMirrorBanner(targetPath) {
  return [
    GENERATED_DOC_BANNER_BEGIN,
    `<!-- DERIVED DOCUMENT: ${targetPath} is generated from SKILL.md. -->`,
    '<!-- Writer: node scripts/generate_instruction_docs.mjs -->',
    '<!-- Read-only check: node scripts/generate_instruction_docs.mjs --check -->',
    '<!-- Do not hand-edit. Drift remedy: edit SKILL.md, then run the writer. -->',
    GENERATED_DOC_BANNER_END,
  ].join('\n');
}

/**
 * Declared per-file transforms applied to the canonical body, in order.
 * Keep this table small and explicit; anything not declared here is drift.
 */
const TARGETS = [
  {
    path: 'central-instructions.md',
    transforms: [],
  },
  {
    path: join('references', 'runtime-core.md'),
    transforms: [
      {
        kind: 'set-first-h1',
        value: '# Excel Inflow runtime core',
        reason: 'per-audience heading: reference doc names its runtime-core role',
      },
    ],
  },
];

/** Strip the leading YAML frontmatter block ("---\n...\n---\n") plus the single blank separator line that follows it. */
export function stripFrontmatter(content) {
  if (!content.startsWith('---\n')) {
    throw new Error(`${CANONICAL} must begin with a YAML frontmatter block (---\\n...\\n---\\n)`);
  }
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error(`${CANONICAL} frontmatter has no closing --- line`);
  }
  let body = content.slice(end + '\n---\n'.length);
  if (body.startsWith('\n')) body = body.slice(1); // blank separator after frontmatter
  return body;
}

/** Apply the declared transform table to the canonical body. */
export function applyTransforms(body, transforms) {
  let out = body;
  for (const t of transforms) {
    if (t.kind === 'set-first-h1') {
      const nl = out.indexOf('\n');
      const firstLine = nl === -1 ? out : out.slice(0, nl);
      if (!firstLine.startsWith('# ')) {
        throw new Error(`set-first-h1 expects the body to start with an H1, got ${JSON.stringify(firstLine)}`);
      }
      out = t.value + (nl === -1 ? '' : out.slice(nl));
    } else {
      throw new Error(`unknown transform kind: ${t.kind}`);
    }
  }
  return out;
}

function insertBannerAfterFirstH1(body, banner) {
  const nl = body.indexOf('\n');
  if (nl === -1 || !body.slice(0, nl).startsWith('# ')) {
    throw new Error('generated instruction body must start with an H1');
  }
  return `${body.slice(0, nl)}\n\n${banner}${body.slice(nl)}`;
}

export function removeInstructionMirrorBanner(body) {
  const begin = body.indexOf(GENERATED_DOC_BANNER_BEGIN);
  const end = body.indexOf(GENERATED_DOC_BANNER_END);
  if (begin === -1 || end === -1 || end < begin) return body;
  const after = end + GENERATED_DOC_BANNER_END.length;
  return `${body.slice(0, begin)}${body.slice(after)}`.replace(/\n{3,}/, '\n\n');
}

export function generateAll(canonicalContent) {
  const body = stripFrontmatter(canonicalContent);
  return TARGETS.map((target) => ({
    path: target.path,
    content: insertBannerAfterFirstH1(
      applyTransforms(body, target.transforms),
      instructionMirrorBanner(target.path),
    ),
  }));
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const rootIndex = args.indexOf('--root');
  const repoRoot = rootIndex === -1 ? DEFAULT_REPO_ROOT : args[rootIndex + 1];
  const supported = new Set(['--check', '--root', repoRoot]);
  const unsupported = args.filter((arg) => !supported.has(arg));
  if (!repoRoot || unsupported.length > 0) {
    throw new Error(`usage: generate_instruction_docs.mjs [--check] [--root <repo-root>]`);
  }
  const canonicalPath = join(repoRoot, CANONICAL);
  const canonicalContent = readFileSync(canonicalPath, 'utf8');
  const generated = generateAll(canonicalContent);

  const mismatches = [];
  for (const { path, content } of generated) {
    const fullPath = join(repoRoot, path);
    let disk;
    try {
      disk = readFileSync(fullPath, 'utf8');
    } catch {
      mismatches.push(path); // missing counts as drifted in --check mode
      continue;
    }
    if (disk !== content) mismatches.push(path);
  }

  if (checkOnly) {
    if (mismatches.length > 0) {
      console.error(
        `doc-single-source: DRIFT DETECTED — regenerate with:\n` +
        `  node scripts/generate_instruction_docs.mjs\n` +
        `drifted files (stale relative to ${CANONICAL}):`
      );
      for (const p of mismatches) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`doc-single-source: OK — ${generated.map((g) => g.path).join(', ')} match ${CANONICAL}.`);
    process.exit(0);
  }

  for (const { path, content } of generated) {
    const fullPath = join(repoRoot, path);
    let before;
    try {
      before = readFileSync(fullPath, 'utf8');
    } catch {
      before = null;
    }
    writeFileSync(fullPath, content, 'utf8');
    console.log(`${before === content ? 'up-to-date' : 'regenerated'}: ${path}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
