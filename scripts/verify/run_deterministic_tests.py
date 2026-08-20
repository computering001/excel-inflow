#!/usr/bin/env python3
"""Shippable determinism harness -- replaces scripts/run_deterministic_tests.mjs.

WHY THE NODE HARNESS DIES WITH THE PORT
---------------------------------------
run_deterministic_tests.mjs compares `<workbook>.inspect.ndjson`, a file only
the legacy workbook library inspector produces.  Remove legacy workbook library and the harness's
single workbook-content comparison -- "workbook-values-and-formulas" -- has no
input at all.

AND IT WAS COMPARING THE WRONG THING ANYWAY
-------------------------------------------
`.inspect.ndjson`'s `table.values` is a PRE-RECALCULATION snapshot.  On
kerry-v2 it records Finance income J:L as 0, 0, 0 and Finance costs as
0, 0, 0, while the workbook that actually ships caches 13.2522 and -61.94 in
those cells.  Comparing build A's pre-recalc snapshot with build B's therefore
cannot see nondeterminism in the cached values the reader will open -- which is
precisely where the circular solve lives, and precisely the class of drift the
harness exists to catch.  This harness reads the values from the workbook's own
`<v>` elements instead, and compares those.

WHAT IT NEEDS, AND WHERE IT NOW GETS IT
---------------------------------------
    row-map / solution / semantic-manifest   canonical JSON of the sidecars
    source-crosswalk                         raw CSV text
    workbook cached values                   the workbook (was: inspect.ndjson)
    workbook formulas                        the workbook (was: inspect.ndjson)
    row topology                             the workbook (was: inspect.ndjson)
    stable package parts                     the .xlsx zip, reached through the
                                             workbook's RELATIONSHIPS (styles
                                             and theme) rather than guessed paths
    comment anchors and text                 the workbook, through each
                                             worksheet's comments relationships
                                             (NEW -- the incumbent only saw
                                             threads via the snapshot, and the
                                             name regex that replaced it could
                                             not see openpyxl's spelling)
    every worksheet, volatile ids masked     the .xlsx zip, resolved by sheet
                                             name. Volatile relationships are
                                             treated identically on all sheets.

USAGE
    # build twice from a case and compare (needs the Node emitter)
    python3 scripts/verify/run_deterministic_tests.py <case.json> [out-dir]

    # compare two builds that already exist (no emitter, no Node at all)
    python3 scripts/verify/run_deterministic_tests.py --builds A.xlsx B.xlsx \
            --out <out-dir>
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from verify.invariants import canonical_json  # noqa: E402
from verify.xlsx import (  # noqa: E402
    REL_COMMENTS,
    REL_THEME,
    PartResolutionError,
    Workbook,
)

SCRIPT_DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Package parts whose bytes are stable across builds, named by the RELATIONSHIP
# that reaches them rather than by a guessed path. Every worksheet is compared
# after masking the closed list of volatile relationship/comment identifiers.
#
# DEFECT 0.15, the same class as the validators'.  These were literals --
# "xl/styles.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml" -- and
# the sheet numbering in particular is a producer's choice, not a fact: the
# workbook's own rels say which part is which sheet.  `part_bytes` at least
# raises on a name that is not in the package, but `sheet1_masked` went through
# `part()`, which returns "" for an absent part, so two builds whose Operating
# Model could not be found compared "" against "" and PASSED having read nothing.
# Identifiers the emitter regenerates on every build.  Masking them is what
# lets the Operating Model part and the comment parts be compared at all.
VOLATILE_PATTERNS = [
    (re.compile(r'(r:id|r:embed|Id|id)="R[0-9a-fA-F]{8,}"'), r'\1="R*"'),
    (re.compile(r"tc=\{[0-9A-Fa-f-]{36}\}"), "tc={*}"),
    (re.compile(r'\bpersonId="\{?[0-9A-Fa-f-]{36}\}?"'), 'personId="*"'),
    (re.compile(r'\bid="\{[0-9A-Fa-f-]{36}\}"'), 'id="{*}"'),
    # Threaded comments carry a wall-clock build timestamp.  Two builds a
    # second apart therefore differ by construction -- which is also why
    # `package_binary_equal` can never be true and is reported as
    # informational only.
    (re.compile(r'\bdT="[^"]*"'), 'dT="*"'),
]


def hash_text(value) -> str:
    if isinstance(value, (bytes, bytearray)):
        return hashlib.sha256(value).hexdigest()
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def mask_volatile(text: str) -> str:
    for pattern, replacement in VOLATILE_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def canonical_json_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return canonical_json(json.load(handle))


def raw_text_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


# ------------------------------------------------------------------ readers


def workbook_cached_values(path: str) -> str:
    """Every cached cell value on every sheet, in a stable order.

    This is the comparison the incumbent thought it was making with
    `.inspect.ndjson`, made against the values that actually ship.
    """
    workbook = Workbook.open(path)
    payload = {}
    for sheet in workbook.sheets:
        payload[sheet.name] = {
            address: sheet.cells[address]
            for address in sorted(sheet.cells, key=address_key)
            if sheet.cells[address] is not None
        }
    return canonical_json(payload)


def workbook_formulas(path: str) -> str:
    workbook = Workbook.open(path)
    payload = {}
    for sheet in workbook.sheets:
        payload[sheet.name] = {
            address: sheet.formula_cells[address]
            for address in sorted(sheet.formula_cells, key=address_key)
        }
    return canonical_json(payload)


_ROW_TAG = re.compile(r"<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>")


def workbook_row_topology(path: str) -> str:
    workbook = Workbook.open(path)
    payload = {}
    for sheet in workbook.sheets:
        rows = []
        for match in _ROW_TAG.finditer(sheet.xml):
            attributes = dict(re.findall(r'([\w:]+)="([^"]*)"', match.group(1)))
            rows.append(
                {
                    "r": attributes.get("r"),
                    "ht": attributes.get("ht"),
                    "hidden": attributes.get("hidden"),
                    "s": attributes.get("s"),
                    "outlineLevel": attributes.get("outlineLevel"),
                }
            )
        payload[sheet.name] = rows
    return canonical_json(payload)


def workbook_comments(path: str) -> str:
    """Comment anchors and text, with the volatile author GUIDs masked.

    The comments parts come from each worksheet's own relationships.  The name
    regex this replaced matched `xl/comments1.xml` and `xl/threadedcomments/...`
    and nothing else, so `xl/comments/comment1.xml` -- which is what openpyxl
    writes, and what this pipeline's plan renderer therefore produces -- was
    invisible, and the comparison silently covered nothing.  Threaded comments
    have no worksheet relationship of their own; they hang off the ordinary
    comments part, so they are still swept by name, but keyed off the parts that
    actually resolved rather than matched blind.
    """
    workbook = Workbook.open(path)
    payload = {}
    resolved = []
    for sheet in workbook.sheets:
        for part in workbook.related_parts(sheet.part, REL_COMMENTS):
            resolved.append(part)
            payload[part] = mask_volatile(workbook.part(part))
    for name in workbook.names:
        if re.match(r"^xl/threadedcomments/.*\.xml$", name):
            payload[name] = mask_volatile(workbook.part(name))
    if not payload:
        # Both producers comment every historical hardcode.  An empty payload is
        # a part that was not found, not a workbook without comments, and two
        # empty payloads comparing equal is exactly the false pass this class of
        # defect produces.
        raise PartResolutionError(
            "no comments part resolved through any worksheet's relationships "
            "in %s (parts: %s)" % (path, ", ".join(sorted(workbook.names)))
        )
    return canonical_json(payload)


def worksheets_masked(path: str) -> str:
    """Every worksheet part, keyed by sheet name, with volatile ids masked."""
    workbook = Workbook.open(path)
    payload = {}
    for sheet in workbook.sheets:
        text = workbook.part(sheet.part)
        if not text:
            raise PartResolutionError(
                "sheet %r resolved to %r, which is absent or empty in %s"
                % (sheet.name, sheet.part, path)
            )
        payload[sheet.name] = mask_volatile(text)
    if not payload:
        raise PartResolutionError("no worksheets resolved in %s" % path)
    return canonical_json(payload)


def address_key(address: str) -> Tuple[int, int]:
    match = re.match(r"^([A-Z]+)(\d+)$", address)
    if not match:
        return (0, 0)
    column = 0
    for character in match.group(1):
        column = column * 26 + ord(character) - 64
    return (int(match.group(2)), column)


COMPARISONS = [
    ("row-map", "{workbook}.row-map.json", canonical_json_file),
    ("independent-solver-solution", "{workbook}.solution.json", canonical_json_file),
    ("semantic-manifest", "{workbook}.semantic-manifest.json", canonical_json_file),
    ("source-crosswalk", "{workbook}.source-crosswalk.csv", raw_text_file),
    ("workbook-cached-values", "{workbook}", workbook_cached_values),
    ("workbook-formulas", "{workbook}", workbook_formulas),
    ("workbook-row-topology", "{workbook}", workbook_row_topology),
    ("workbook-comments", "{workbook}", workbook_comments),
    ("worksheets-all-masked", "{workbook}", worksheets_masked),
]


def build(case_path: str, workbook_path: str, node_binary: str, builder: str) -> None:
    subprocess.run(
        [node_binary, builder, case_path, "--out", workbook_path],
        check=True,
        capture_output=True,
    )


def main(argv: List[str]) -> int:
    options: Dict[str, Any] = {}
    positional: List[str] = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--builds":
            options["builds"] = [argv[index + 1], argv[index + 2]]
            index += 3
            continue
        if token.startswith("--"):
            key = token[2:]
            following = argv[index + 1] if index + 1 < len(argv) else None
            if following is None or following.startswith("--"):
                options[key] = True
                index += 1
            else:
                options[key] = following
                index += 2
            continue
        positional.append(token)
        index += 1

    node_binary = (
        options.get("node")
        or os.environ.get("NODE_BINARY")
        or shutil.which("node")
    )
    builder = options.get(
        "builder", os.path.join(SCRIPT_DIRECTORY, "build_dynamic_model.mjs")
    )

    case_path: Optional[str] = None
    if options.get("builds"):
        first_workbook = os.path.abspath(options["builds"][0])
        second_workbook = os.path.abspath(options["builds"][1])
        output_directory = os.path.abspath(
            options.get("out") or os.path.join(os.path.dirname(first_workbook), "deterministic-tests")
        )
        os.makedirs(output_directory, exist_ok=True)
    else:
        if not positional:
            raise SystemExit(
                "Usage: run_deterministic_tests.py <representative-v2-case.json> "
                "[output-folder]   |   --builds A.xlsx B.xlsx --out <folder>"
            )
        if not node_binary:
            raise SystemExit(
                "Node.js is required when building from a case. Put `node` on "
                "PATH, set NODE_BINARY, or pass --node <path>. Existing builds "
                "can still be compared with --builds A.xlsx B.xlsx."
            )
        case_path = os.path.abspath(positional[0])
        output_directory = os.path.abspath(
            positional[1]
            if len(positional) > 1
            else os.path.join(os.path.dirname(case_path), "deterministic-tests")
        )
        os.makedirs(output_directory, exist_ok=True)
        first_workbook = os.path.join(output_directory, "build-a.xlsx")
        second_workbook = os.path.join(output_directory, "build-b.xlsx")
        build(case_path, first_workbook, node_binary, builder)
        build(case_path, second_workbook, node_binary, builder)

    comparisons = []
    for identifier, template, reader in COMPARISONS:
        try:
            first = reader(template.format(workbook=first_workbook))
            second = reader(template.format(workbook=second_workbook))
        except OSError as error:
            comparisons.append(
                {"id": identifier, "status": "fail", "error": str(error)}
            )
            continue
        comparisons.append(
            {
                "id": identifier,
                "status": "pass" if first == second else "fail",
                "first_sha256": hash_text(first),
                "second_sha256": hash_text(second),
            }
        )

    first_package = Workbook.open(first_workbook)
    second_package = Workbook.open(second_workbook)
    # Resolved, not guessed: the styles part through the workbook's own
    # relationship. Worksheets are compared separately after masking only the
    # enumerated volatile identifiers.
    # A part that resolves differently in the two builds is itself a
    # determinism failure and is reported rather than quietly compared.
    stable_parts = [("styles", first_package.styles_part, second_package.styles_part)]
    stable_parts.append(
        (
            "theme",
            next(iter(first_package.related_parts(first_package.workbook_part, REL_THEME)), None),
            next(iter(second_package.related_parts(second_package.workbook_part, REL_THEME)), None),
        )
    )
    for label, first_part, second_part in stable_parts:
        if not first_part or not second_part:
            comparisons.append(
                {
                    "id": "package-part:%s" % label,
                    "status": "fail",
                    "detail": "resolved to %r and %r" % (first_part, second_part),
                }
            )
            continue
        first = first_package.part_bytes(first_part)
        second = second_package.part_bytes(second_part)
        comparisons.append(
            {
                "id": "package-part:%s" % label,
                "status": "pass"
                if first == second and first_part == second_part
                else "fail",
                "first_part": first_part,
                "second_part": second_part,
                "first_sha256": hash_text(first),
                "second_sha256": hash_text(second),
            }
        )

    with open(first_workbook, "rb") as handle:
        first_binary = handle.read()
    with open(second_workbook, "rb") as handle:
        second_binary = handle.read()

    failures = [item for item in comparisons if item["status"] != "pass"]
    report = {
        "schema_version": 1,
        "harness": "excel-inflow-v2-python",
        "port_of": "scripts/run_deterministic_tests.mjs",
        "status": "PASS" if not failures else "FAIL",
        "total_violations": len(failures),
        "case": case_path,
        "builds": [first_workbook, second_workbook],
        "summary": {
            "passed": len(comparisons) - len(failures),
            "failed": len(failures),
            "total_violations": len(failures),
        },
        "comparisons": comparisons,
        "package_binary_equal": first_binary == second_binary,
        "package_binary_note": (
            "Binary identity is informational only: the emitter mints fresh "
            "relationship and threaded-comment identifiers on every build. The "
            "production gate compares semantic row topology, CACHED VALUES read "
            "from the workbook itself, formulas, solver results, comments and "
            "stable style/package parts."
        ),
        "replaces_inspect_ndjson": (
            "The Node harness compared <workbook>.inspect.ndjson, which only the "
            "legacy workbook library inspector produces AND which holds a pre-recalculation "
            "snapshot (kerry-v2 records forecast Finance income/costs as 0 while "
            "the shipped workbook caches 13.2522 / -61.94). Values are now read "
            "from the workbook's own <v> elements."
        ),
    }
    report_path = os.path.join(output_directory, "deterministic-test-report.json")
    with open(report_path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(report, indent=2, default=str) + "\n")

    print(
        "STATUS=%s exit=%d comparisons=%d total_violations=%d"
        % (
            report["status"],
            1 if failures else 0,
            len(comparisons),
            len(failures),
        )
    )
    if failures:
        print("FAILING COMPARISONS: " + ", ".join(item["id"] for item in failures))
    print(report_path)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
