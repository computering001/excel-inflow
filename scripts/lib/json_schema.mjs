function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function resolvePointer(rootSchema, reference) {
  if (!reference.startsWith("#/")) {
    throw new Error(`Only local JSON Schema references are supported: ${reference}`);
  }
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => current?.[part], rootSchema);
}

function validDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateNode(value, schema, rootSchema, path, errors) {
  if (schema === true || schema == null) return;
  if (schema === false) {
    errors.push(`${path} is not allowed by the schema.`);
    return;
  }
  if (schema.$ref) {
    const resolved = resolvePointer(rootSchema, schema.$ref);
    if (!resolved) errors.push(`${path} references missing schema ${schema.$ref}.`);
    else validateNode(value, resolved, rootSchema, path, errors);
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}.`);
    return;
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}.`);
    return;
  }

  const allowedTypes = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => typeMatches(value, type))) {
    errors.push(`${path} must have type ${allowedTypes.join(" or ")}.`);
    return;
  }

  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} character(s).`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path} does not match required pattern ${schema.pattern}.`);
    }
    if (schema.format === "date" && !validDateString(value)) {
      errors.push(`${path} must be a valid YYYY-MM-DD date.`);
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${path} must be at least ${schema.minimum}.`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`${path} must be no more than ${schema.maximum}.`);
    }
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) {
      errors.push(`${path} must be greater than ${schema.exclusiveMinimum}.`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} item(s).`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${path} must contain no more than ${schema.maxItems} item(s).`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (let index = 0; index < value.length; index += 1) {
        const canonical = canonicalJson(value[index]);
        if (seen.has(canonical)) {
          errors.push(`${path}[${index}] duplicates an earlier item; items must be unique.`);
        }
        seen.add(canonical);
      }
    }
    if (schema.contains) {
      const containsMatch = value.some((item, index) => {
        const candidateErrors = [];
        validateNode(item, schema.contains, rootSchema, `${path}[${index}]`, candidateErrors);
        return candidateErrors.length === 0;
      });
      if (!containsMatch) {
        errors.push(`${path} must contain at least one item matching the required schema.`);
      }
    }
    const prefixCount = schema.prefixItems?.length ?? 0;
    for (let index = 0; index < Math.min(prefixCount, value.length); index += 1) {
      validateNode(value[index], schema.prefixItems[index], rootSchema, `${path}[${index}]`, errors);
    }
    for (let index = prefixCount; index < value.length; index += 1) {
      if (schema.items === false) {
        errors.push(`${path}[${index}] is not allowed.`);
      } else if (schema.items) {
        validateNode(value[index], schema.items, rootSchema, `${path}[${index}]`, errors);
      }
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required.`);
    }
    const declared = schema.properties ?? {};
    for (const [key, childValue] of Object.entries(value)) {
      if (Object.hasOwn(declared, key)) {
        validateNode(childValue, declared[key], rootSchema, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not an allowed property.`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        validateNode(
          childValue,
          schema.additionalProperties,
          rootSchema,
          `${path}.${key}`,
          errors,
        );
      }
    }
  }

  for (const branch of schema.allOf ?? []) {
    validateNode(value, branch, rootSchema, path, errors);
  }
  // P1.4: oneOf/anyOf were silently unenforced here while 10+ shipped
  // schemas declare them — an invalid object could pass its producer and
  // surface much later in Build. Enforcement matches JSON Schema semantics:
  // anyOf requires at least one matching branch; oneOf exactly one.
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const matched = schema.anyOf.some((branch) => {
      const branchErrors = [];
      validateNode(value, branch, rootSchema, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (!matched) errors.push(`${path} matches none of the anyOf branches.`);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    let matches = 0;
    for (const branch of schema.oneOf) {
      const branchErrors = [];
      validateNode(value, branch, rootSchema, path, branchErrors);
      if (branchErrors.length === 0) matches += 1;
    }
    if (matches !== 1) {
      errors.push(`${path} must match exactly one oneOf branch; matched ${matches}.`);
    }
  }
  if (schema.if) {
    const conditionErrors = [];
    validateNode(value, schema.if, rootSchema, path, conditionErrors);
    if (conditionErrors.length === 0 && schema.then) {
      validateNode(value, schema.then, rootSchema, path, errors);
    } else if (conditionErrors.length > 0 && schema.else) {
      validateNode(value, schema.else, rootSchema, path, errors);
    }
  }
}

export function validateJsonSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, schema, "$", errors);
  return errors;
}
