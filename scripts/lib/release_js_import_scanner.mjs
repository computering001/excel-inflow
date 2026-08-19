/**
 * Return the literal module specifiers that can contribute to a shipped
 * JavaScript closure.
 *
 * The scanner is intentionally grammar-bounded. In particular, an
 * `export const` or `export function` declaration is not an export-from
 * declaration, so later prose containing `from "..."` cannot be joined to it.
 * Match starts are also required to be in JavaScript code rather than inside a
 * comment, quoted string, or template literal.
 */

const IDENTIFIER = "[A-Za-z_$][\\w$]*";

const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*(["'])([^"']+)\1/gm;
const IMPORT_FROM = new RegExp(
  `^[ \\t]*import\\s+(?:(?:${IDENTIFIER}\\s*,\\s*)?(?:\\*\\s+as\\s+${IDENTIFIER}|\\{[^}]*\\})|${IDENTIFIER})\\s+from\\s*(["'])([^"']+)\\1`,
  "gm",
);
const EXPORT_FROM = new RegExp(
  `^[ \\t]*export\\s+(?:\\*\\s*(?:as\\s+${IDENTIFIER}\\s*)?|\\{[^}]*\\}\\s*)from\\s*(["'])([^"']+)\\1`,
  "gm",
);
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g;
const NON_LITERAL_DYNAMIC_IMPORT = /\bimport\s*\(\s*(?!["'])[^)\s]/g;

function codePositions(source) {
  const code = new Uint8Array(source.length);
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line-comment";
        index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block-comment";
        index += 1;
        continue;
      }
      if (char === "'") {
        state = "single-quote";
        continue;
      }
      if (char === '"') {
        state = "double-quote";
        continue;
      }
      if (char === "`") {
        state = "template";
        continue;
      }
      code[index] = 1;
      continue;
    }

    if (state === "line-comment") {
      if (char === "\n" || char === "\r") {
        state = "code";
        code[index] = 1;
      }
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (
      (state === "single-quote" && char === "'") ||
      (state === "double-quote" && char === '"') ||
      (state === "template" && char === "`")
    ) {
      state = "code";
    }
  }
  return code;
}

function tokenStart(source, match) {
  const leading = match[0].match(/^[ \t]*/)?.[0].length ?? 0;
  return match.index + leading;
}

function matchesInCode(source, pattern, code) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].filter((match) => code[tokenStart(source, match)] === 1);
}

export function specifiersOf(source) {
  const code = codePositions(source);
  const found = [];
  for (const pattern of [
    SIDE_EFFECT_IMPORT,
    IMPORT_FROM,
    EXPORT_FROM,
    DYNAMIC_IMPORT,
    REQUIRE_CALL,
  ]) {
    for (const match of matchesInCode(source, pattern, code)) {
      found.push(match[2]);
    }
  }
  return [...new Set(found)];
}

export function hasNonLiteralDynamicImport(source) {
  const code = codePositions(source);
  return matchesInCode(source, NON_LITERAL_DYNAMIC_IMPORT, code).length > 0;
}
