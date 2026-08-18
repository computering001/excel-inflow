import fs from "node:fs";

const ONTOLOGY = Object.freeze(
  JSON.parse(
    fs.readFileSync(
      new URL("../../assets/debt-class-ontology-v1.json", import.meta.url),
      "utf8",
    ),
  ),
);

export const CANONICAL_DEBT_CLASSES = Object.freeze([
  ...ONTOLOGY.canonical_classes,
]);
export const CANONICAL_DEBT_CLASS_SET = Object.freeze(
  new Set(CANONICAL_DEBT_CLASSES),
);
export const LEGACY_DEBT_CLASS_ALIASES = Object.freeze({
  ...ONTOLOGY.legacy_aliases,
});

export function canonicalDebtClass(value, { acceptLegacy = true } = {}) {
  const token = String(value ?? "").trim().toLowerCase();
  if (CANONICAL_DEBT_CLASS_SET.has(token)) return token;
  if (acceptLegacy && LEGACY_DEBT_CLASS_ALIASES[token]) {
    return LEGACY_DEBT_CLASS_ALIASES[token];
  }
  return "unclassified";
}

export function isLegacyDebtClass(value) {
  return Object.hasOwn(
    LEGACY_DEBT_CLASS_ALIASES,
    String(value ?? "").trim().toLowerCase(),
  );
}

export function debtClassPresentation(value) {
  const canonical = assertCanonicalDebtClass(value);
  return {
    class: canonical,
    ...ONTOLOGY.presentation[canonical],
  };
}

export function debtClassGroup(value) {
  return debtClassPresentation(value).group;
}

export function debtClassGroupLabel(value) {
  return debtClassPresentation(value).group_label;
}

export function debtClassTypeLabel(value) {
  return debtClassPresentation(value).type_label;
}

export function assertCanonicalDebtClass(value) {
  const token = String(value ?? "").trim().toLowerCase();
  if (!CANONICAL_DEBT_CLASS_SET.has(token)) {
    throw new Error(
      `Debt class ${JSON.stringify(value)} is not canonical; map legacy input through the explicit adapter before model compilation.`,
    );
  }
  return token;
}

export function migrateLegacyDebtClasses(modelCase) {
  const migrations = [];
  for (const instrument of modelCase?.instruments ?? []) {
    const sourceClass = String(instrument?.class ?? "").trim().toLowerCase();
    if (CANONICAL_DEBT_CLASS_SET.has(sourceClass)) continue;
    const targetClass = canonicalDebtClass(sourceClass);
    instrument.class = targetClass;
    migrations.push({
      instrument_id: instrument.instrument_id,
      source_class: sourceClass || null,
      canonical_class: targetClass,
      mapping:
        LEGACY_DEBT_CLASS_ALIASES[sourceClass]
          ? "legacy_alias"
          : "unrecognised_to_review",
    });
  }
  modelCase.debt_class_contract_version = "debt-class-ontology/1.0";
  if (migrations.length > 0) {
    modelCase.debt_class_migrations = migrations;
  } else {
    delete modelCase.debt_class_migrations;
  }
  return migrations;
}

export default {
  CANONICAL_DEBT_CLASSES,
  LEGACY_DEBT_CLASS_ALIASES,
  canonicalDebtClass,
  isLegacyDebtClass,
  debtClassPresentation,
  debtClassGroup,
  debtClassGroupLabel,
  debtClassTypeLabel,
  assertCanonicalDebtClass,
  migrateLegacyDebtClasses,
};
