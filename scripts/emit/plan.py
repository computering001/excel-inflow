"""
Load and validate a render plan.

A renderer that accepts a malformed plan renders a guess, and a guess that looks
like a workbook is the exact failure this architecture exists to prevent. So the
plan is validated before a single cell is placed.

deployment host has `jsonschema` natively and it is used when importable. The fallback is a
deliberately small draft-07 subset — enough for this schema and nothing more —
so the renderer still fails closed in an environment that lacks it rather than
silently skipping validation.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "assets" / "plan.schema.json"

SUPPORTED_PLAN_VERSIONS = {"1"}


class PlanError(ValueError):
    """The plan is not something this renderer may act on."""


# ---------------------------------------------------------------------------
# Minimal draft-07 subset validator
# ---------------------------------------------------------------------------

_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "number": (int, float),
    "integer": int,
    "boolean": bool,
    "null": type(None),
}


def _is_type(value, name):
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "boolean":
        return isinstance(value, bool)
    expected = _TYPES.get(name)
    return expected is not None and isinstance(value, expected)


def _resolve(root, ref):
    if not ref.startswith("#/"):
        raise PlanError(f"Unsupported $ref: {ref}")
    node = root
    for part in ref[2:].split("/"):
        node = node[part.replace("~1", "/").replace("~0", "~")]
    return node


def _validate(value, schema, root, path, errors):
    if "$ref" in schema:
        _validate(value, _resolve(root, schema["$ref"]), root, path, errors)
        return

    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected {schema['const']!r}, got {value!r}")
        return

    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} is not one of {schema['enum']}")
        return

    if "oneOf" in schema:
        matches = 0
        for option in schema["oneOf"]:
            trial: list[str] = []
            _validate(value, option, root, path, trial)
            if not trial:
                matches += 1
        if matches != 1:
            errors.append(f"{path}: matched {matches} of {len(schema['oneOf'])} alternatives")
        return

    declared = schema.get("type")
    if declared is not None:
        names = declared if isinstance(declared, list) else [declared]
        if not any(_is_type(value, name) for name in names):
            errors.append(f"{path}: expected type {declared}, got {type(value).__name__}")
            return

    if isinstance(value, str):
        pattern = schema.get("pattern")
        if pattern and not re.search(pattern, value):
            errors.append(f"{path}: {value!r} does not match /{pattern}/")
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: longer than {schema['maxLength']}")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        for key, ok in (
            ("minimum", lambda v, b: v >= b),
            ("maximum", lambda v, b: v <= b),
            ("exclusiveMinimum", lambda v, b: v > b),
            ("exclusiveMaximum", lambda v, b: v < b),
        ):
            if key in schema and not ok(value, schema[key]):
                errors.append(f"{path}: fails {key}={schema[key]} (value {value})")

    if isinstance(value, list):
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(value):
                _validate(item, item_schema, root, f"{path}[{index}]", errors)
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: fewer than {schema['minItems']} items")

    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required property {key!r}")
        properties = schema.get("properties", {})
        names = schema.get("propertyNames")
        additional = schema.get("additionalProperties", True)
        for key, item in value.items():
            if names is not None:
                _validate(key, names, root, f"{path}/{key} (name)", errors)
            if key in properties:
                _validate(item, properties[key], root, f"{path}.{key}", errors)
            elif additional is False:
                errors.append(f"{path}: unexpected property {key!r}")
            elif isinstance(additional, dict):
                _validate(item, additional, root, f"{path}.{key}", errors)


def validate(plan, schema=None, limit=40):
    """Return a list of human-readable validation errors; empty means valid."""
    if schema is None:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf8"))
    try:
        import jsonschema  # type: ignore
    except ImportError:
        errors: list[str] = []
        _validate(plan, schema, schema, "$", errors)
        return errors[:limit]

    validator = jsonschema.Draft7Validator(schema)
    return [
        f"{'/'.join(str(part) for part in error.absolute_path) or '$'}: {error.message}"
        for error in list(validator.iter_errors(plan))[:limit]
    ]


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load(path, *, validate_schema=True):
    """
    Read a plan and refuse anything this renderer must not act on.

    Refusals, not warnings. An unknown plan_version means the contract moved and
    the renderer's assumptions about it are stale; rendering anyway would
    produce a workbook that looks complete and is wrong.
    """
    plan = json.loads(Path(path).read_text(encoding="utf8"))

    version = plan.get("plan_version")
    if version not in SUPPORTED_PLAN_VERSIONS:
        raise PlanError(
            f"plan_version {version!r} is not supported by this renderer "
            f"(supports {sorted(SUPPORTED_PLAN_VERSIONS)}). "
            "Refusing to render rather than guess at a moved contract."
        )

    if validate_schema:
        errors = validate(plan)
        if errors:
            listed = "\n- ".join(errors)
            raise PlanError(f"Plan does not conform to plan.schema.json:\n- {listed}")

    # Referential integrity, which a schema cannot express. A dangling style
    # index would render a cell in the default style: no provenance colour, no
    # number format, and nothing to say it happened.
    workbook = plan["workbook"]
    style_count = len(workbook["styles"])
    dxf_count = len(workbook.get("differential_styles", []))
    for sheet in workbook["sheets"]:
        for address, cell in sheet["cells"].items():
            index = cell.get("s")
            if index is not None and not 0 <= index < style_count:
                raise PlanError(f"{sheet['name']}!{address}: style index {index} out of range")
            if "f_shared_slave" in cell:
                raise PlanError(
                    f"{sheet['name']}!{address}: shared-formula slave carries no formula text. "
                    "The plan must resolve shared formulas before the renderer sees them."
                )
        for block in sheet.get("conditional_formats", []):
            for rule in block["rules"]:
                index = rule.get("dxf")
                if index is not None and not 0 <= index < dxf_count:
                    raise PlanError(
                        f"{sheet['name']} {block['sqref']}: dxf index {index} out of range"
                    )
        merges = sheet.get("merges", [])
        if merges:
            raise PlanError(
                f"{sheet['name']}: plan declares merged ranges {merges}. "
                "layout.merged_calculation_cells_forbidden is a standing rule; "
                "block titles centre with horizontal=centerContinuous instead."
            )

    return plan
