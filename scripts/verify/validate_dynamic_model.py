#!/usr/bin/env python3
"""Shippable Python port of scripts/validate_dynamic_model.mjs.

WHY THIS EXISTS
---------------
The Node validator imports `private workbook library`, which is private, licence-
forbidden to redistribute, and native to darwin.  It cannot ship to deployment host.  It
also carries the only independent solver-parity check in the system -- the sole
in-sandbox authority on whether the emitted workbook agrees with the
independently computed economics, including the circular set's fixed point that
nothing else inside deployment host can verify.  Losing it would leave the certification
claim standing with nothing under it.

This port needs Python 3.9+ and nothing else: no openpyxl, no lxml, no numpy.
Every check the Node suite defines is reproduced; see CHECK_MAP below.

USAGE
    python3 scripts/verify/validate_dynamic_model.py <workbook.xlsx> --out <dir>
            [--tolerance-mode contract|legacy] [--tolerance 0.05]
            [--visual-reviewed <file>] [--finance-reviewed <json>]

`--tolerance-mode legacy` reproduces the incumbent's single absolute 0.05 and
exists only so the port can be diffed check-for-check against the Node
validator.  The default, `contract`, uses metric-class tolerances (see
verify/tolerances.py).

--------------------------------------------------------------------------
BLIND SPOTS -- what this validator CANNOT see
--------------------------------------------------------------------------
Stated here rather than buried, because a validator whose blind spots are
undocumented invites exactly the over-trust that has already cost this project
real time.

 1. IT DOES NOT RECALCULATE THE WORKBOOK.  Every value it reads is the cached
    value the emitter wrote into `<v>`.  If the emitter cached a value that
    Excel would not reproduce from the formula beside it, this validator will
    happily agree with the cache.  Only `native-excel-toggle-restoration` --
    which is MANUAL, and unsupplied by default -- can see that.  In particular
    the circular set's fixed point is checked as "the cache agrees with the
    independent Python solver", not as "Excel converges here".
 2. IT SEES ONE CONTROL STATE.  The workbook ships with circularity either on
    or off; `control-formula-gates` asserts the caches agree with whichever
    state is present and that the formula text survives a toggle, but it cannot
    execute the toggle.  On/off/on/off/on restoration is manual evidence.
 3. `formula-errors` SEARCHES CACHED VALUES ONLY.  This is faithful to the
    incumbent: probing legacy workbook library's `inspect({kind:"match"})` showed a
    search for "IFERROR" -- present in hundreds of formulas -- returning zero
    hits, while a search for a cell's text returned `"match":"value"`.  A
    formula that would evaluate to #REF! but whose cached value is stale and
    numeric is invisible to it.
 4. SHEETS 2 AND 3 ARE BARELY CHECKED.  Only `sheet-contract` and
    `formula-errors` look at Brokers and Forward Curves at all.  Their contents
    are validated by other scripts, not this one.
 5. NO RENDERING, NO LAYOUT.  Column widths, freeze panes, print areas,
    conditional formatting and cell borders are outside every check here.
    `typography-contract` covers font name/size and section-title colour only.
 6. `historical-provenance-comments` CHECKS PRESENCE, NOT TRUTH.  A comment
    that says the wrong thing passes.
 7. `semantic-artifact-*`, `coverage-gate` and `independent-solver-parity` all
    read sidecar JSON produced by the same build that produced the workbook.
    They detect disagreement between the build's own artefacts; they cannot
    detect a build that is consistently wrong.
 8. TOLERANCE IS A POLICY, NOT A PROOF.  Under `contract` mode a currency
    difference below 1e-6 relative and a leverage difference below 1e-4
    absolute are recorded as agreement.
 9. IT DOES NOT VALIDATE THE CASE INPUTS.  Garbage in the case JSON that the
    solver and the emitter both honour is agreement, not correctness.
10. THE TWO MANUAL CHECKS ARE NOT COVERAGE.  With no evidence supplied the
    overall status is PASS_PENDING_MANUAL, which is not PASS.
11. PROVENANCE COMMENTS ARE RESOLVED THROUGH THE WORKSHEET'S RELATIONSHIPS, and
    every comments part the sheet declares is read.  The part name is not
    guessed: `xl/comments1.xml` and `xl/comments/comment1.xml` are both legal and
    both occur among this pipeline's producers.  What remains outside the check
    is comments attached to any sheet other than Operating Model.
12. `statement-arithmetic` NOW ACCEPTS LINK-COMPILED ROWS on the strength of
    the link resolving to a named row (see the check).  It therefore no longer
    asserts that the emitter chose the RIGHT row to link to; that binding is a
    build-time contract, checked by the row plan and the semantic manifest, not
    by this validator.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.setrecursionlimit(30000)

from verify.invariants import (  # noqa: E402
    build_native_evidence_bindings,
    embedded_rate_literals,
    parse_csv,
    sha256,
    validate_fiscal_periods,
    validate_native_evidence,
    validate_semantic_artifacts,
)
from verify.tolerances import (  # noqa: E402
    LegacyTolerancePolicy,
    TolerancePolicy,
    numeric,
)
from verify.xlsx import (  # noqa: E402
    REL_COMMENTS,
    REL_DRAWING,
    REL_EXTERNAL_LINK,
    Workbook,
    same_sheet_references,
)

FORECAST_COLUMNS = ["J", "K", "L"]
ADJUSTMENT_COLUMNS = ["N", "O", "P"]
PRO_FORMA_COLUMNS = ["S", "T", "U"]
ALL_MODEL_COLUMNS = (
    ["G", "H", "I"] + FORECAST_COLUMNS + ADJUSTMENT_COLUMNS + ["R"] + PRO_FORMA_COLUMNS
)

# Semantic roles the arithmetic check exempts: their authority lives in the debt
# schedule, the sweep or the interest schedule, not in a declared calculation.
MECHANICAL_ROLES = {
    "interest_income",
    "interest_expense",
    "opening_cash",
    "ending_cash",
    "debt_issuance",
    "debt_repayment",
    "rcf_draw",
    "rcf_repayment",
    "lease_principal",
    "acquisition_consideration",
    "acquisition_debt_proceeds",
    "non_cash_interest_addback",
}

# --------------------------------------------------------------------------
# CHECK MAP -- every named check in validate_dynamic_model.mjs and its
# counterpart here.  All 29 are ported; none was dropped.  A check silently
# lost in a port is worse than one that fails, because the coverage claim
# survives while the coverage does not.
#
#  #  Node check id                            Python counterpart      Status
#  1  sheet-contract                           same id                 ported *
#  2  coverage-gate                            same id                 ported
#  3  semantic-artifact-completeness           same id                 ported
#  4  semantic-artifact-case-binding           same id                 ported
#  5  fiscal-year-period-contract              same id                 ported
#  6  single-rcf-input-authority               same id                 ported
#  7  formula-errors                           same id                 ported *
#  8  external-workbook-links                  same id                 ported
#  9  no-unintended-drawings                   same id                 ported
# 10  dynamic-section-map                      same id                 ported
# 11  three-historical-three-forecast          same id                 ported
# 12  binary-controls                          same id                 ported
# 13  iteration-contract                       same id                 ported
# 14  hidden-mechanics                         same id                 ported
# 15  historical-provenance-comments           same id                 ported
# 16  font-colour-contract                     same id                 ported +
# 17  typography-contract                      same id                 ported
# 18  number-format-colour-contract            same id                 ported
# 19  statement-arithmetic                     same id                 ported +
# 20  standalone-adjustment-pro-forma-tie      same id                 ported
# 21  pro-forma-actual-tie                     same id                 ported
# 22  interest-cash-rcf-ties                   same id                 ported
# 23  cfs-waterfall-component-parity           same id                 ported
# 24  liquidity-certification                  same id                 ported
# 25  control-formula-gates                    same id                 ported
# 26  visible-interest-assumption-references   same id                 ported
# 27  independent-solver-parity                same id                 ported
# 28  native-excel-toggle-restoration          same id                 ported (manual)
# 29  visual-review                            same id                 ported (manual)
#
# * Re-implemented rather than transliterated, because these two were the paths
#   an earlier survey of the legacy workbook library surface MISSED.  The survey listed
#   `importXlsx`, `getRange().values` and `getRange().formulas`; the validator
#   also called `workbook.inspect({kind:"sheet"})` for #1 and
#   `workbook.inspect({kind:"match"})` for #7.  Both are replaced in
#   verify/xlsx.py, the match scope having been established by probing
#   legacy workbook library directly rather than assumed.
#
# + Deliberately NOT bug-compatible:
#   #19 statement-arithmetic -- the incumbent recomputed rows the emitter
#      compiles as links.  See the comment at the check itself.
#   #16 font-colour-contract -- the incumbent's `xmlCellFormula` fallback
#      mis-parses SELF-CLOSING `<c r="G22" s="40"/>` cells: its regex has no
#      self-closing branch, so it runs on to the next `</c>` and attributes a
#      LATER cell's formula to the empty one.  On kerry-v2 that makes G22, H22
#      and I22 -- three genuinely empty cells -- appear to hold
#      `'Brokers'!D21`, and the check then demands they be green.  All 18
#      font-colour violations across the 6 failing certification cases are this
#      artefact; every reported address is an empty self-closing cell.  This
#      port parses the XML properly and reports no violation.
CHECK_COUNT = 29


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def parse_args(argv: List[str]):
    positional: List[str] = []
    options: Dict[str, Any] = {}
    index = 0
    while index < len(argv):
        token = argv[index]
        if not token.startswith("--"):
            positional.append(token)
            index += 1
            continue
        key = token[2:]
        following = argv[index + 1] if index + 1 < len(argv) else None
        if following is None or following.startswith("--"):
            options[key] = True
            index += 1
        else:
            options[key] = following
            index += 2
    return positional, options


def review_evidence(file_path, json_required: bool = False) -> Dict[str, Any]:
    if not file_path or file_path is True:
        return {"supplied": False, "passed": False, "evidence": None}
    try:
        with open(file_path, "rb") as handle:
            contents = handle.read()
        if os.path.splitext(file_path)[1].lower() != ".json":
            return {
                "supplied": True,
                "passed": (not json_required) and len(contents) > 0,
                "evidence": os.path.abspath(file_path),
            }
        parsed = json.loads(contents.decode("utf-8"))
        status = str(
            parsed.get("status") or (parsed.get("summary") or {}).get("status") or ""
        ).upper()
        return {
            "supplied": True,
            "passed": status == "PASS",
            "data": parsed,
            "evidence": {"path": os.path.abspath(file_path), "status": status or None},
        }
    except Exception as error:  # noqa: BLE001 - mirrors the Node catch-all
        return {
            "supplied": True,
            "passed": False,
            "evidence": {"path": os.path.abspath(file_path), "error": str(error)},
        }


def record(check_id, passed, message, evidence=None, status=None, violations=None):
    resolved = status or ("pass" if passed else "fail")
    if violations is None:
        violations = 0 if passed else (len(evidence) if isinstance(evidence, list) else 1)
        if resolved == "manual":
            violations = 0
    return {
        "id": check_id,
        "status": resolved,
        "severity": "manual" if status == "manual" else "critical",
        "message": message,
        "violations": violations,
        "evidence": evidence,
    }


def calculation_value(values_by_id, prior_values_by_id, calculation):
    if not calculation:
        return None
    refs = calculation.get("refs") or []
    values = [numeric(values_by_id.get(ref)) for ref in refs]
    operator = calculation.get("operator")
    if operator == "sum":
        return sum(values)
    if operator == "link":
        return values[0] if values else 0
    if operator == "subtract":
        result = values[0] if values else 0
        for item in values[1:]:
            result -= item
        return result
    if operator == "negate":
        return -(values[0] if values else 0)
    if operator == "negate_sum":
        return -sum(values)
    if operator == "ratio":
        return 0 if len(values) < 2 or values[1] == 0 else values[0] / values[1]
    if operator == "negated_ratio":
        return 0 if len(values) < 2 or values[1] == 0 else -values[0] / values[1]
    if operator == "growth":
        prior = numeric((prior_values_by_id or {}).get(refs[0]))
        return 0 if prior == 0 else values[0] / prior - 1
    if operator == "tax":
        return -values[0] * values[1] if len(values) > 1 and values[0] > 0 else 0
    if operator == "prior_period":
        return numeric((prior_values_by_id or {}).get(refs[0]))
    if operator == "prior_period_scaled_by":
        prior_value = numeric((prior_values_by_id or {}).get(refs[0]))
        current_driver = numeric(values_by_id.get(refs[1]))
        prior_driver = numeric((prior_values_by_id or {}).get(refs[1]))
        return 0 if prior_driver == 0 else prior_value * current_driver / prior_driver
    if operator == "average":
        return 0 if not values else sum(values) / len(values)
    return None


# ------------------------------------------------------------------ styles

_PREFIX = r"(?:[A-Za-z_][\w.-]*:)?"
_FONTS_BLOCK = re.compile(r"<%sfonts\b[^>]*>([\s\S]*?)</%sfonts>" % (_PREFIX, _PREFIX))
_FONT = re.compile(r"<%sfont\b[^>]*>([\s\S]*?)</%sfont>" % (_PREFIX, _PREFIX))
_FONT_RGB = re.compile(r'<%scolor\b[^>]*\brgb="([A-Fa-f0-9]{8})"' % _PREFIX)
_FONT_NAME = re.compile(r'<%sname\b[^>]*\bval="([^"]+)"' % _PREFIX)
_FONT_SIZE = re.compile(r'<%ssz\b[^>]*\bval="([^"]+)"' % _PREFIX)
_FONT_BOLD_A = re.compile(r"<%sb(?:\s[^>]*)?/>" % _PREFIX)
_FONT_BOLD_B = re.compile(r"<%sb\b[^>]*>" % _PREFIX)
_NUMFMT = re.compile(r"<%snumFmt\b([^>]*)/?>" % _PREFIX)
_CELLXFS_BLOCK = re.compile(
    r"<%scellXfs\b[^>]*>([\s\S]*?)</%scellXfs>" % (_PREFIX, _PREFIX)
)
_XF = re.compile(r"<%sxf\b([^>]*)/?>" % _PREFIX)
_WS_CELL = re.compile(r"<%sc\b([^>]*)/?>" % _PREFIX)

_DEFAULT_STYLE = {
    "color": "000000",
    "name": None,
    "size": 0,
    "bold": False,
    "numFmtId": 0,
    "numberFormat": None,
}


def style_maps(styles_xml: str, worksheet_xml: str) -> Dict[str, Dict[str, Any]]:
    fonts_match = _FONTS_BLOCK.search(styles_xml)
    fonts_block = fonts_match.group(1) if fonts_match else ""
    fonts = []
    for match in _FONT.finditer(fonts_block):
        body = match.group(1)
        rgb = _FONT_RGB.search(body)
        name = _FONT_NAME.search(body)
        size = _FONT_SIZE.search(body)
        fonts.append(
            {
                "color": rgb.group(1)[-6:].upper() if rgb else "000000",
                "name": name.group(1) if name else None,
                "size": float(size.group(1)) if size else 0.0,
                "bold": bool(_FONT_BOLD_A.search(body) or _FONT_BOLD_B.search(body)),
            }
        )
    custom_number_formats: Dict[int, str] = {}
    for match in _NUMFMT.finditer(styles_xml):
        attributes = match.group(1)
        identifier = re.search(r'\bnumFmtId="(\d+)"', attributes)
        code = re.search(r'\bformatCode="([^"]*)"', attributes)
        if identifier and code:
            custom_number_formats[int(identifier.group(1))] = code.group(1).replace(
                "&quot;", '"'
            )
    xfs_match = _CELLXFS_BLOCK.search(styles_xml)
    cell_xfs_block = xfs_match.group(1) if xfs_match else ""
    style_definitions = []
    for match in _XF.finditer(cell_xfs_block):
        attributes = match.group(1)
        font_id = re.search(r'\bfontId="(\d+)"', attributes)
        num_fmt_id = re.search(r'\bnumFmtId="(\d+)"', attributes)
        font_index = int(font_id.group(1)) if font_id else 0
        number_format_id = int(num_fmt_id.group(1)) if num_fmt_id else 0
        base = (
            fonts[font_index]
            if 0 <= font_index < len(fonts)
            else {"color": "000000", "name": None, "size": 0, "bold": False}
        )
        entry = dict(base)
        entry["numFmtId"] = number_format_id
        entry["numberFormat"] = custom_number_formats.get(number_format_id)
        style_definitions.append(entry)
    cell_styles: Dict[str, Dict[str, Any]] = {}
    for match in _WS_CELL.finditer(worksheet_xml):
        attributes = match.group(1)
        address = re.search(r'\br="([A-Z]+\d+)"', attributes)
        if not address:
            continue
        style_id = re.search(r'\bs="(\d+)"', attributes)
        index = int(style_id.group(1)) if style_id else 0
        cell_styles[address.group(1)] = (
            style_definitions[index]
            if 0 <= index < len(style_definitions)
            else dict(_DEFAULT_STYLE)
        )
    return cell_styles


# --------------------------------------------------------------------------
# Part resolution goes through the RELATIONSHIP, never through a guessed name.
#
# `xl/comments1.xml` was hardcoded here.  That is one legal spelling out of
# several: the part name is whatever the producer chose, and the only thing that
# makes it findable is the worksheet's own `.rels`.  The artifact writer happens
# to emit `xl/comments1.xml`; openpyxl — which is what `emit build` renders a
# plan through — emits `xl/comments/comment1.xml`.  Both are conformant, both
# resolve in Excel, and the hardcoded reader saw only one of them, so every
# comment on a plan-rendered workbook read as absent.  That is the same class of
# defect as asking for a sheet by a guessed name instead of by its relationship.
# The resolver now lives on `Workbook` itself, because the reader has the same
# problem for the parts it needs to boot at all — `workbook.xml`, `styles.xml`,
# `sharedStrings.xml`, each worksheet — and one resolver for all of them is the
# point.  `xlsx.Workbook.related_parts` fails loudly where the old local copy
# returned an empty list.
_RELATIONSHIP_COMMENTS = REL_COMMENTS


def related_parts(workbook: Workbook, part: str, relationship_type: str) -> List[str]:
    """Every part `part` points at with `relationship_type`, in declared order."""
    return workbook.related_parts(part, relationship_type)


def sheet_comments_xml(workbook: Workbook, sheet) -> str:
    """The comments part(s) a worksheet declares, concatenated.

    Concatenated rather than "the first one": a producer may legally split a
    sheet's comments across more than one part, and taking only the head would
    reinstate the same silent under-read in a different disguise.
    """
    return "".join(
        workbook.part(name) for name in related_parts(
            workbook, sheet.part, _RELATIONSHIP_COMMENTS
        )
    )


# --------------------------------------------------------------------------
def main(argv: List[str]) -> int:
    positional, options = parse_args(argv)
    if not positional or not options.get("out"):
        raise SystemExit(
            "Usage: validate_dynamic_model.py <workbook.xlsx> --out <folder> "
            "[--tolerance-mode contract|legacy] [--visual-reviewed <image>] "
            "[--finance-reviewed <json>]"
        )
    input_path = os.path.abspath(positional[0])
    output_directory = os.path.abspath(options["out"])
    os.makedirs(output_directory, exist_ok=True)

    with open(input_path + ".row-map.json", "rb") as handle:
        row_map_buffer = handle.read()
    row_plan = json.loads(row_map_buffer.decode("utf-8"))
    with open(input_path + ".solution.json", "r", encoding="utf-8") as handle:
        solution = json.load(handle)
    with open(input_path + ".coverage.json", "r", encoding="utf-8") as handle:
        coverage = json.load(handle)
    with open(input_path + ".semantic-manifest.json", "r", encoding="utf-8") as handle:
        semantic_manifest_text = handle.read()
    with open(input_path + ".source-crosswalk.csv", "r", encoding="utf-8") as handle:
        source_crosswalk_text = handle.read()
    with open(input_path, "rb") as handle:
        workbook_buffer = handle.read()

    semantic_manifest = json.loads(semantic_manifest_text)
    source_crosswalk = parse_csv(source_crosswalk_text)

    workbook = Workbook.open(input_path)
    operating_model = workbook.sheet("Operating Model")
    worksheet_xml = operating_model.xml
    styles_xml = workbook.styles_xml
    workbook_xml = workbook.workbook_xml
    comments_xml = sheet_comments_xml(workbook, operating_model)

    units = ((solution.get("standalone") or {}).get("issuer") or {}).get("units")
    mode = options.get("tolerance-mode", "contract")
    # The contract's `tolerances.cli_override` rule: --tolerance still exists for
    # diagnosis, but supplying it must be recorded on the face of the report so a
    # report produced under a loosened tolerance can never be mistaken for one
    # produced under the contract's.  Supplying it therefore forces the scalar
    # policy AND stamps `tolerance_override` on the report.
    if mode == "legacy" or options.get("tolerance") is not None:
        mode = "legacy"
        policy = LegacyTolerancePolicy(float(options.get("tolerance", 0.05)))
    else:
        policy = TolerancePolicy.load(units)

    def value(address):
        return operating_model.value(address)

    def cell_formula(address) -> str:
        return operating_model.formula(address)

    def equal(left, right, metric_class="currency") -> bool:
        return policy.equal(left, right, metric_class)

    finance_review = review_evidence(options.get("finance-reviewed"), json_required=True)
    visual_review = review_evidence(options.get("visual-reviewed"))
    checks: List[Dict[str, Any]] = []

    # ---------------------------------------------------------- sheet-contract
    sheets = workbook.sheet_names
    allowed_sheets = ["Operating Model", "Brokers", "Forward Curves"]
    checks.append(
        record(
            "sheet-contract",
            all(name in allowed_sheets for name in sheets)
            and all(name in sheets for name in allowed_sheets),
            "Workbook contains only the three approved production sheets.",
            {"sheets": sheets, "allowedSheets": allowed_sheets},
        )
    )

    # ------------------------------------------------------------ coverage-gate
    checks.append(
        record(
            "coverage-gate",
            coverage.get("ready_to_build") is True,
            "The persisted coverage report passed before build.",
            coverage.get("summary"),
        )
    )

    formula_lengths = sorted(
        len(text)
        for text in operating_model.formula_cells.values()
        if isinstance(text, str) and text.startswith("=")
    )
    formula_maximum = formula_lengths[-1] if formula_lengths else 0
    formula_p95 = (
        formula_lengths[
            min(len(formula_lengths) - 1, int(len(formula_lengths) * 0.95))
        ]
        if formula_lengths
        else 0
    )
    checks.append(
        record(
            "formula-complexity-contract",
            formula_maximum <= 1600 and formula_p95 <= 750,
            "Visible formulas remain auditable: no formula exceeds 1,600 "
            "characters and the 95th percentile does not exceed 750 characters.",
            {
                "formula_count": len(formula_lengths),
                "maximum_characters": formula_maximum,
                "p95_characters": formula_p95,
                "maximum_allowed": 1600,
                "p95_allowed": 750,
            },
        )
    )

    # ------------------------------------------ semantic-artifact-completeness
    semantic_artifact_errors = validate_semantic_artifacts(
        semantic_manifest, source_crosswalk
    )
    checks.append(
        record(
            "semantic-artifact-completeness",
            len(semantic_artifact_errors) == 0,
            "The semantic manifest and source crosswalk contain no unresolved "
            "dependencies or orphan material source rows.",
            semantic_artifact_errors[:100],
            violations=len(semantic_artifact_errors),
        )
    )

    checks.append(
        record(
            "semantic-artifact-case-binding",
            semantic_manifest.get("case_id") == solution.get("case_id")
            and bool(
                re.match(r"^[a-f0-9]{64}$", str(semantic_manifest.get("case_sha256") or ""))
            ),
            "Semantic artifacts are bound to the solved case by case ID and "
            "deterministic case hash.",
            {
                "manifest_case_id": semantic_manifest.get("case_id"),
                "solution_case_id": solution.get("case_id"),
                "case_sha256": semantic_manifest.get("case_sha256"),
            },
        )
    )

    fiscal_period_errors = validate_fiscal_periods(
        {
            "issuer": {"fiscal_year_end": semantic_manifest.get("fiscal_year_end")},
            "periods": semantic_manifest.get("periods"),
        }
    )
    checks.append(
        record(
            "fiscal-year-period-contract",
            len(fiscal_period_errors) == 0,
            "All six periods end on the issuer's declared fiscal year-end, "
            "including non-December issuers.",
            fiscal_period_errors,
            violations=len(fiscal_period_errors),
        )
    )

    # ------------------------------------------------ single-rcf-input-authority
    rcf_contract = semantic_manifest.get("rcf_contract") or {}
    rcf_contract_errors: List[Dict[str, Any]] = []
    for key in (
        "instrument_id",
        "policy_opening_draw",
        "instrument_opening_balance",
        "policy_capacity",
        "instrument_capacity",
    ):
        if rcf_contract.get(key) in (None, ""):
            rcf_contract_errors.append({"id": "missing_%s" % key})
    if not equal(
        rcf_contract.get("policy_opening_draw"),
        rcf_contract.get("instrument_opening_balance"),
        policy.class_for("input-authority", "currency"),
    ):
        rcf_contract_errors.append(
            {
                "id": "opening_draw",
                "policy": rcf_contract.get("policy_opening_draw"),
                "instrument": rcf_contract.get("instrument_opening_balance"),
            }
        )
    if not equal(
        rcf_contract.get("policy_capacity"),
        rcf_contract.get("instrument_capacity"),
        policy.class_for("input-authority", "currency"),
    ):
        rcf_contract_errors.append(
            {
                "id": "capacity",
                "policy": rcf_contract.get("policy_capacity"),
                "instrument": rcf_contract.get("instrument_capacity"),
            }
        )
    checks.append(
        record(
            "single-rcf-input-authority",
            len(rcf_contract_errors) == 0,
            "The visible RCF opening draw and capacity resolve to one reconciled "
            "instrument source.",
            rcf_contract_errors,
            violations=len(rcf_contract_errors),
        )
    )

    # ------------------------------------------------------------ formula-errors
    error_matches = workbook.match_values(
        r"#(REF!|DIV/0!|VALUE!|NAME\?|N/A|NUM!)", max_results=1000
    )
    checks.append(
        record(
            "formula-errors",
            len(error_matches) == 0,
            "No spreadsheet formula errors were found.",
            {"matched": len(error_matches), "entries": error_matches[:50]},
            violations=len(error_matches),
        )
    )

    # --------------------------------------------------- external-workbook-links
    # DEFECT 0.15.  `startswith("xl/externalLinks/")` is a naming CONVENTION, not
    # the fact.  An external workbook link is a workbook-level RELATIONSHIP, and
    # a producer that parks the part anywhere else still has the link while this
    # reported "no external-workbook link" about it.  The relationship is now the
    # authority; the name sweep is kept BESIDE it, because a part in
    # `xl/externalLinks/` that no relationship points at is orphaned rather than
    # harmless and should be reported too.
    external_link_relationships = workbook.related_parts(
        workbook.workbook_part, REL_EXTERNAL_LINK
    )
    external_link_parts_by_name = [
        name for name in workbook.names if name.startswith("xl/externalLinks/")
    ]
    external_link_parts = sorted(
        set(external_link_relationships) | set(external_link_parts_by_name)
    )
    bracketed_references = re.findall(r"\[[^\]]+\]", worksheet_xml)
    external_links_visited = bool(workbook.names) and bool(worksheet_xml)
    checks.append(
        record(
            "external-workbook-links",
            external_links_visited
            and not external_link_parts
            and not bracketed_references,
            "No external-workbook link was found."
            if external_links_visited
            else "The external-link scan saw no zip entries or an empty worksheet "
            "— the check cannot pass on an empty visit.",
            {
                "zip_entries_scanned": len(workbook.names),
                "worksheet_xml_length": len(worksheet_xml),
                "workbook_part": workbook.workbook_part,
                "external_link_relationships": external_link_relationships,
                "external_link_parts_by_name": external_link_parts_by_name,
                "external_link_parts": external_link_parts,
                "bracketed_references": bracketed_references[:20],
            },
            violations=len(external_link_parts)
            + len(bracketed_references)
            + (0 if external_links_visited else 1),
        )
    )

    # ------------------------------------------------------ no-unintended-drawings
    # DEFECT 0.15, same shape.  A drawing is a WORKSHEET relationship; the regex
    # missed any part a producer named something else, and this check exists
    # precisely to catch a shape or chart nobody meant to ship.
    worksheet_parts = [sheet.part for sheet in workbook.sheets]
    drawing_relationships = sorted(
        {
            part
            for worksheet_part in worksheet_parts
            for part in workbook.related_parts(worksheet_part, REL_DRAWING)
        }
    )
    drawing_parts_by_name = [
        name
        for name in workbook.names
        if re.match(r"^xl/drawings/drawing[^/]*\.xml$", name, re.I)
    ]
    ordinary_drawing_parts = sorted(
        set(drawing_relationships) | set(drawing_parts_by_name)
    )
    # DEFECT 0.12.  An empty package, or one whose sheets never resolved, yields
    # an empty result — which is the pass condition.  Both are asserted first.
    drawing_scan_visited = bool(workbook.names) and bool(worksheet_parts)
    checks.append(
        record(
            "no-unintended-drawings",
            drawing_scan_visited and not ordinary_drawing_parts,
            "No ordinary DrawingML shape or chart part is present in the "
            "production workbook."
            if drawing_scan_visited
            else "The drawing-part scan listed ZERO zip entries or resolved ZERO "
            "worksheets — the check cannot pass on an empty visit.",
            {
                "zip_entries_scanned": len(workbook.names),
                "worksheets_scanned": worksheet_parts,
                "drawing_relationships": drawing_relationships,
                "drawing_parts_by_name": drawing_parts_by_name,
                "drawing_parts": ordinary_drawing_parts,
            },
            violations=len(ordinary_drawing_parts)
            + (0 if drawing_scan_visited else 1),
        )
    )

    # ------------------------------------------------------- dynamic-section-map
    expected_sections = {
        "income_statement": "3. INCOME STATEMENT",
        "cash_flow": "4. CASH FLOW",
        "debt_schedule": "5. DEBT SCHEDULE",
        "rcf_waterfall": "6. RCF CASH SWEEP",
        "interest_schedule": "7. INTEREST SCHEDULE",
    }
    bad_sections = []
    for section_id, expected in expected_sections.items():
        row = row_plan["section_headers"][section_id]
        actual = value("B%s" % row)
        if actual != expected:
            bad_sections.append(
                {"id": section_id, "row": row, "expected": expected, "actual": actual}
            )
    checks.append(
        record(
            "dynamic-section-map",
            len(bad_sections) == 0,
            "All six CRH sections resolve through the dynamic row plan.",
            bad_sections,
            violations=len(bad_sections),
        )
    )

    periods = [
        value("%s%s" % (column, row_plan["period_row"]))
        for column in ["G", "H", "I", "J", "K", "L"]
    ]
    checks.append(
        record(
            "three-historical-three-forecast",
            all(item is not None and item != "" for item in periods),
            "The model contains exactly three historical and three forecast periods.",
            periods,
            violations=sum(1 for item in periods if item is None or item == ""),
        )
    )

    # ------------------------------------------------------------ binary-controls
    control_evidence = {
        "circularity": value("C%s" % row_plan["controls"]["circularity"]),
        "debt_maturities_roll": value(
            "C%s" % row_plan["controls"]["debt_maturities_roll"]
        ),
        "adjustments": value("P%s" % row_plan["controls"]["adjustments_enabled"]),
    }
    checks.append(
        record(
            "binary-controls",
            all(
                isinstance(item, (int, float))
                and not isinstance(item, bool)
                and item in (0, 1)
                for item in control_evidence.values()
            ),
            "Circularity, maturity roll and adjustment-columns controls are numeric "
            "1/0 toggles.",
            control_evidence,
        )
    )

    iterate_count = re.search(r'\biterateCount="([^"]+)"', workbook_xml)
    iterate_delta = re.search(r'\biterateDelta="([^"]+)"', workbook_xml)
    checks.append(
        record(
            "iteration-contract",
            bool(re.search(r'\biterate="(?:1|true)"', workbook_xml))
            and (
                not re.search(r"\biterateCount=", workbook_xml)
                or bool(re.search(r'\biterateCount="100"', workbook_xml))
            )
            and (
                not re.search(r"\biterateDelta=", workbook_xml)
                or bool(re.search(r'\biterateDelta="0\.001"', workbook_xml))
            ),
            "Workbook calculation settings use 100 iterations and 0.001 tolerance.",
            {
                "iterate_enabled": bool(re.search(r'\biterate="(?:1|true)"', workbook_xml)),
                "iterate_count": iterate_count.group(1)
                if iterate_count
                else "100 (Excel default)",
                "iterate_delta": iterate_delta.group(1)
                if iterate_delta
                else "0.001 (Excel default)",
            },
        )
    )

    # ----------------------------------------------------------- hidden-mechanics
    hidden_rows = [
        int(match.group(1))
        for match in re.finditer(
            r'<%srow\b[^>]*\br="(\d+)"[^>]*\bhidden="1"[^>]*>' % _PREFIX, worksheet_xml
        )
    ]
    rows_below_visible_end = [
        int(match.group(1))
        for match in re.finditer(
            r'<%srow\b[^>]*\br="(\d+)"[^>]*>' % _PREFIX, worksheet_xml
        )
        if int(match.group(1)) > row_plan["visible_end_row"]
    ]
    checks.append(
        record(
            "hidden-mechanics",
            len(hidden_rows) == 0 and len(rows_below_visible_end) == 0,
            "No hidden rows and no content below the last visible row -- every "
            "mechanical calculation is on the face of the model.",
            {
                "hidden_rows": hidden_rows,
                "rows_below_visible_end": rows_below_visible_end,
            },
            violations=len(hidden_rows) + len(rows_below_visible_end),
        )
    )

    # --------------------------------------------- historical-provenance-comments
    comment_refs = set(re.findall(r'\bref="([A-Z]+\d+)"', comments_xml))
    # A READER THAT RESOLVED NOTHING HAS NOT PASSED.  Every case in the suite
    # carries provenance comments, so an empty anchor set means the comments part
    # was not found — which is precisely the failure the hardcoded `comments1.xml`
    # produced, and it must not be reportable as "nothing was missing".
    comment_resolution_errors = []
    if not comment_refs:
        comment_resolution_errors.append(
            "no comment anchors resolved through %s's relationships (parts: %s)"
            % (
                operating_model.part,
                ", ".join(
                    related_parts(workbook, operating_model.part, _RELATIONSHIP_COMMENTS)
                )
                or "none declared",
            )
        )
    all_statement_rows = (
        row_plan["statement_rows"]["income_statement"]
        + row_plan["statement_rows"]["cash_flow"]
    )
    missing_comments = []
    for definition in all_statement_rows:
        for index in range(3):
            address = "%s%s" % (["G", "H", "I"][index], definition["row"])
            cell_value = value(address)
            text = cell_formula(address)
            literal_historical = definition.get("row_type") in ("input", "uncalculated") or (
                definition.get("row_type") in ("calculation", "subtotal")
                and len(((definition.get("calculation") or {}).get("refs")) or []) == 0
            )
            if (
                literal_historical
                and cell_value is not None
                and cell_value != ""
                and not text
                and address not in comment_refs
            ):
                missing_comments.append(address)
    checks.append(
        record(
            "historical-provenance-comments",
            len(missing_comments) == 0 and len(comment_resolution_errors) == 0,
            "Every populated historical statement hardcode carries a source comment.",
            comment_resolution_errors + missing_comments,
            violations=len(missing_comments) + len(comment_resolution_errors),
        )
    )

    # ------------------------------------------------------- font-colour-contract
    styles = style_maps(styles_xml, worksheet_xml)
    colour_errors = []
    for definition in all_statement_rows:
        if definition.get("row_type") == "header":
            continue
        for column in ALL_MODEL_COLUMNS:
            address = "%s%s" % (column, definition["row"])
            cell_value = value(address)
            text = cell_formula(address)
            if (cell_value is None or cell_value == "") and not text:
                continue
            if text:
                expected = (
                    "008000"
                    if re.search(r"(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!", text)
                    else "000000"
                )
            else:
                expected = "0000FF"
            actual = (styles.get(address) or {}).get("color")
            if expected and actual != expected:
                colour_errors.append(
                    {
                        "address": address,
                        "expected": expected,
                        "actual": actual,
                        "formula": text,
                    }
                )
    checks.append(
        record(
            "font-colour-contract",
            len(colour_errors) == 0,
            "Historical hardcodes are blue, internal formulas black and cross-sheet "
            "formulas green.",
            colour_errors[:50],
            violations=len(colour_errors),
        )
    )

    # -------------------------------------------------------- typography-contract
    typography_errors = []
    red_number_formats = []
    for address, style in styles.items():
        match = re.match(r"^([A-Z]+)(\d+)$", address)
        if not match:
            continue
        if int(match.group(2)) > row_plan["visible_end_row"]:
            continue
        cell_value = value(address)
        text = cell_formula(address)
        if (cell_value is None or cell_value == "") and not text:
            continue
        if style.get("name") != "Calibri" or abs(numeric(style.get("size")) - 8) > 1e-9:
            typography_errors.append(
                {
                    "address": address,
                    "expected_name": "Calibri",
                    "expected_size": 8,
                    "actual_name": style.get("name"),
                    "actual_size": style.get("size"),
                }
            )
        if re.search(r"\[Red\]", style.get("numberFormat") or "", re.I):
            red_number_formats.append(
                {"address": address, "number_format": style.get("numberFormat")}
            )
    for row in row_plan["section_headers"].values():
        style = styles.get("B%s" % row)
        if style and (style.get("color") != "FFFFFF" or style.get("bold") is not True):
            typography_errors.append(
                {
                    "address": "B%s" % row,
                    "expected": "white bold section title",
                    "actual": style,
                }
            )
    checks.append(
        record(
            "typography-contract",
            len(typography_errors) == 0,
            "Visible populated cells use Calibri 8 and section titles are white and bold.",
            typography_errors[:50],
            violations=len(typography_errors),
        )
    )
    checks.append(
        record(
            "number-format-colour-contract",
            len(red_number_formats) == 0,
            "Number formats do not override hardcode/formula font-colour semantics.",
            red_number_formats[:50],
            violations=len(red_number_formats),
        )
    )

    # ------------------------------------------------------- statement-arithmetic
    #
    # DEFECT FIXED IN THIS PORT (the incumbent fails 6 of 8 certification cases
    # on it).  The Node check recomputes every declared calculation from its
    # semantic refs.  But the emitter compiles `change_in_debt` /
    # `net_change_in_debt` as a LINK to the debt schedule's total-change row --
    # `=J116` -- and leaves the four component rows it declares as refs
    # completely unpopulated in the forecast columns.  Recomputing therefore
    # sums four empty cells, expects 0, and reports the (correct) linked value
    # as a violation.  It is a validator bug, not a model defect.
    #
    # The fix does not drop coverage.  Where the emitter authored a cell as a
    # pure same-sheet link, the declared calculation was never its authority, so
    # in place of the recomputation two assertions that ARE meaningful are made:
    #   (a) the cached value equals the cached value of the cell it links to --
    #       a stale cache on either side breaks this;
    #   (b) the link target is a row the row plan names (a debt-schedule,
    #       sweep, interest-schedule, instrument or statement row) rather than
    #       an arbitrary cell, so a link into scratch space is still a failure.
    named_rows = set()
    for group in (
        "section_headers",
        "controls",
        "debt_summary_rows",
        "waterfall_rows",
        "interest_summary_rows",
        "debt_fx_rows",
        "benchmark_rows",
    ):
        block = row_plan.get(group)
        if isinstance(block, dict):
            named_rows.update(int(v) for v in block.values() if isinstance(v, int))
    for plan in row_plan.get("instruments") or []:
        for key in ("debt_row", "undrawn_row", "issuance_row", "amortisation_row", "interest_row"):
            if isinstance(plan.get(key), int):
                named_rows.add(plan[key])
    named_rows.update(int(item["row"]) for item in all_statement_rows)
    named_rows.update(
        int(v) for v in (row_plan.get("rows_by_id") or {}).values() if isinstance(v, int)
    )

    pure_link = re.compile(r"^=\$?([A-Z]{1,3})\$?(\d+)$")

    def metric_class_for(definition, calculation) -> str:
        if definition.get("number_format") == "percentage":
            return "rate"
        operator = (calculation or {}).get("operator")
        if operator in ("ratio", "negated_ratio", "growth"):
            return "rate"
        return "currency"

    arithmetic_errors = []
    link_compiled = []
    # A check that inspected zero rows has not passed, it has failed to run.
    arithmetic_visited = 0
    prior_column_map = {"H": "G", "I": "H", "K": "J", "L": "K", "T": "S", "U": "T"}
    for column in ["G", "H", "I"] + FORECAST_COLUMNS + PRO_FORMA_COLUMNS:
        values_by_id = {
            definition["row_id"]: value("%s%s" % (column, definition["row"]))
            for definition in all_statement_rows
        }
        prior_column = prior_column_map.get(column)
        prior_values = (
            {
                definition["row_id"]: value("%s%s" % (prior_column, definition["row"]))
                for definition in all_statement_rows
            }
            if prior_column
            else None
        )
        forecast_like = column in FORECAST_COLUMNS or column in PRO_FORMA_COLUMNS
        forecast_index = (
            FORECAST_COLUMNS.index(column)
            if column in FORECAST_COLUMNS
            else PRO_FORMA_COLUMNS.index(column)
            if column in PRO_FORMA_COLUMNS
            else None
        )
        for definition in all_statement_rows:
            if forecast_like:
                period_rules = definition.get("forecast_period_calculations")
                if isinstance(period_rules, list):
                    active = (
                        period_rules[forecast_index]
                        if column in FORECAST_COLUMNS
                        else None
                    )
                else:
                    active = definition.get("forecast_calculation")
                if active is None and not isinstance(period_rules, list):
                    active = (
                        None
                        if definition.get("forecast_treatment")
                        in ("broker", "uncalculated")
                        else definition.get("calculation")
                    )
            else:
                active = definition.get("calculation")
            if not active:
                continue
            if definition.get("semantic_role") in MECHANICAL_ROLES:
                continue
            if forecast_like and not isinstance(
                definition.get("forecast_period_calculations"), list
            ):
                active = definition.get("forecast_calculation") or definition.get(
                    "calculation"
                )
            if active.get("operator") in (
                "growth",
                "prior_period",
                "prior_period_scaled_by",
            ) and not prior_values:
                continue
            if (
                not forecast_like
                and active.get("operator") == "prior_period"
                and len(active.get("refs") or []) == 1
                and (active.get("refs") or [None])[0] == definition["row_id"]
            ):
                continue

            address = "%s%s" % (column, definition["row"])
            arithmetic_visited += 1
            emitted = cell_formula(address)
            link = pure_link.match(emitted or "")
            if link:
                target = "%s%s" % (link.group(1), link.group(2))
                target_row = int(link.group(2))
                entry = {
                    "address": address,
                    "row_id": definition["row_id"],
                    "link_target": target,
                }
                if not equal(
                    value(address),
                    value(target),
                    policy.class_for(
                        "cross-row-equality", metric_class_for(definition, active)
                    ),
                ):
                    entry["issue"] = "link_value_does_not_match_target"
                    entry["actual"] = value(address)
                    entry["target_value"] = value(target)
                    arithmetic_errors.append(entry)
                elif target_row not in named_rows:
                    entry["issue"] = "link_target_is_not_a_named_row"
                    arithmetic_errors.append(entry)
                else:
                    link_compiled.append(entry)
                continue

            expected = calculation_value(values_by_id, prior_values, active)
            actual = values_by_id.get(definition["row_id"])
            if not equal(
                actual,
                expected,
                policy.class_for(
                    "statement-arithmetic", metric_class_for(definition, active)
                ),
            ):
                arithmetic_errors.append(
                    {
                        "address": address,
                        "row_id": definition["row_id"],
                        "expected": expected,
                        "actual": actual,
                    }
                )
    checks.append(
        record(
            "statement-arithmetic",
            arithmetic_visited > 0 and len(arithmetic_errors) == 0,
            "Statement calculations, subtotals, ratios and growth rows recompute from "
            "their semantic components; rows the emitter compiled as links tie to the "
            "named row they link to."
            if arithmetic_visited > 0
            else "Statement arithmetic inspected ZERO rows -- the check cannot pass on "
            "an empty visit.",
            {
                "visited": arithmetic_visited,
                "differences": arithmetic_errors[:50],
                "link_compiled_rows": len(link_compiled),
                "link_compiled_sample": link_compiled[:5],
            },
            violations=len(arithmetic_errors) or (0 if arithmetic_visited else 1),
        )
    )

    # ------------------------------------------ standalone-adjustment-pro-forma-tie
    adjustment_errors = []
    for index in range(3):
        for definition in all_statement_rows:
            operators = [
                (definition.get("calculation") or {}).get("operator"),
                (definition.get("forecast_calculation") or {}).get("operator"),
            ]
            is_derived_rate = any(
                operator and re.search(r"(ratio|margin|growth|percentage|rate)", operator, re.I)
                for operator in operators
            )
            if definition.get("row_type") == "header" or is_derived_rate:
                continue
            standalone = value("%s%s" % (FORECAST_COLUMNS[index], definition["row"]))
            adjustment = value("%s%s" % (ADJUSTMENT_COLUMNS[index], definition["row"]))
            pro_forma = value("%s%s" % (PRO_FORMA_COLUMNS[index], definition["row"]))
            if not equal(
                pro_forma,
                numeric(standalone) + numeric(adjustment),
                policy.class_for("standalone-adjustment-pro-forma-tie", "currency"),
            ):
                adjustment_errors.append(
                    {
                        "row_id": definition["row_id"],
                        "period_index": index,
                        "standalone": standalone,
                        "adjustment": adjustment,
                        "pro_forma": pro_forma,
                    }
                )
    checks.append(
        record(
            "standalone-adjustment-pro-forma-tie",
            len(adjustment_errors) == 0,
            "Every statement row ties standalone plus adjustment to pro forma.",
            adjustment_errors[:50],
            violations=len(adjustment_errors),
        )
    )

    # ------------------------------------------------------- pro-forma-actual-tie
    pro_forma_actual_errors = []
    for definition in all_statement_rows:
        if definition.get("row_type") == "header":
            continue
        actual_address = "I%s" % definition["row"]
        pro_forma_actual_address = "R%s" % definition["row"]
        text = cell_formula(pro_forma_actual_address)
        formula_ties = re.sub(r"^=", "", str(text)) == "I%s" % definition["row"]
        if not formula_ties or not equal(
            value(actual_address),
            value(pro_forma_actual_address),
            policy.class_for(
                "cross-row-equality",
                metric_class_for(definition, definition.get("calculation")),
            ),
        ):
            pro_forma_actual_errors.append(
                {
                    "row_id": definition["row_id"],
                    "actual_address": actual_address,
                    "pro_forma_actual_address": pro_forma_actual_address,
                    "actual": value(actual_address),
                    "pro_forma_actual": value(pro_forma_actual_address),
                    "formula": text,
                }
            )
    checks.append(
        record(
            "pro-forma-actual-tie",
            len(pro_forma_actual_errors) == 0,
            "The pro-forma actual column reproduces the latest standalone actual for "
            "every statement row.",
            pro_forma_actual_errors[:50],
            violations=len(pro_forma_actual_errors),
        )
    )

    # ---------------------------------------------------- interest-cash-rcf-ties
    interest_rows = row_plan["interest_summary_rows"]
    waterfall_rows = row_plan["waterfall_rows"]
    debt_rows = row_plan["debt_summary_rows"]
    key_tie_errors = []
    tie_class = policy.class_for("cross-row-equality", "currency")
    main_interest_row = next(
        item["row"]
        for item in all_statement_rows
        if item.get("semantic_role") == "interest_expense"
    )
    main_cash_row = next(
        item["row"]
        for item in all_statement_rows
        if item.get("semantic_role") == "ending_cash"
    )
    balancing_cash_row = next(
        (
            bucket["balance_row"]
            for bucket in (row_plan.get("cash_buckets") or [])
            if bucket.get("forecast_treatment") == "balancing"
        ),
        main_cash_row,
    )
    for index, column in enumerate(FORECAST_COLUMNS):
        for block_column in (column, PRO_FORMA_COLUMNS[index]):
            solution_period = (
                solution["standalone"]["forecast"][index]
                if block_column == column
                else solution["pro_forma"]["forecast"][index]
            )
            left = "%s%s" % (block_column, main_interest_row)
            right = "%s%s" % (block_column, interest_rows["gross_interest_expense"])
            if not equal(value(left), value(right), tie_class):
                key_tie_errors.append({"left": left, "right": right})
            swept_cash = (
                numeric(value("%s%s" % (block_column, waterfall_rows["cash_before_rcf"])))
                + numeric(
                    value("%s%s" % (block_column, waterfall_rows["rcf_draw_waterfall"]))
                )
                - numeric(
                    value(
                        "%s%s" % (block_column, waterfall_rows["rcf_repayment_waterfall"])
                    )
                )
            )
            if not equal(
                numeric(value("%s%s" % (block_column, balancing_cash_row))),
                swept_cash,
                tie_class,
            ):
                key_tie_errors.append(
                    {
                        "left": "%s%s" % (block_column, balancing_cash_row),
                        "right": "cash_before_rcf + rcf_draw - rcf_repayment",
                        "swept": swept_cash,
                    }
                )
            opening = numeric(
                value("%s%s" % (block_column, waterfall_rows["opening_rcf"]))
            )
            draw = numeric(
                value("%s%s" % (block_column, waterfall_rows["rcf_draw_waterfall"]))
            )
            repayment = numeric(
                value("%s%s" % (block_column, waterfall_rows["rcf_repayment_waterfall"]))
            )
            ending = numeric(value("%s%s" % (block_column, waterfall_rows["ending_rcf"])))
            fx_values = (
                solution_period.get("rcf_opening_fx"),
                solution_period.get("rcf_average_fx"),
                solution_period.get("rcf_ending_fx"),
            )
            has_native_rcf_audit = all(
                item is not None and numeric(item) > 0 for item in fx_values
            )
            expected_ending = (
                (
                    opening / numeric(fx_values[0])
                    + draw / numeric(fx_values[1])
                    - repayment / numeric(fx_values[1])
                )
                * numeric(fx_values[2])
                if has_native_rcf_audit
                else opening + draw - repayment
            )
            if not equal(ending, expected_ending, tie_class):
                key_tie_errors.append(
                    {
                        "address": "%s%s" % (block_column, waterfall_rows["ending_rcf"]),
                        "opening": opening,
                        "draw": draw,
                        "repayment": repayment,
                        "ending": ending,
                        "expected_ending": expected_ending,
                        "rcf_currency": solution_period.get("rcf_currency"),
                    }
                )
    checks.append(
        record(
            "interest-cash-rcf-ties",
            len(key_tie_errors) == 0,
            "Interest, ending cash and RCF roll-forward ties hold in standalone and "
            "pro forma.",
            key_tie_errors,
            violations=len(key_tie_errors),
        )
    )

    # --------------------------------------------- cfs-waterfall-component-parity
    formula_cache: Dict[str, str] = {}

    def reference_path_count(start_address: str, target_address: str) -> int:
        memo: Dict[str, int] = {}
        active = set()

        def walk(address: str) -> int:
            if address == target_address:
                return 1
            if address in memo:
                return memo[address]
            if address in active:
                return 0
            active.add(address)
            total = 0
            for dependency in same_sheet_references(cell_formula(address)):
                total += walk(dependency)
            active.discard(address)
            memo[address] = total
            return total

        return walk(start_address)

    def formula_closure(start_address: str, max_cells: int = 250):
        queue = [start_address]
        visited = set()
        formulas = []
        references = []
        seen_references = set()
        while queue and len(visited) < max_cells:
            address = queue.pop(0)
            if address in visited:
                continue
            visited.add(address)
            text = cell_formula(address)
            if not text:
                continue
            formulas.append({"address": address, "formula": text})
            for reference in same_sheet_references(text):
                if reference not in seen_references:
                    seen_references.add(reference)
                    references.append(reference)
                if reference not in visited:
                    queue.append(reference)
        return {"formulas": formulas, "references": references}

    cash_component_nodes = [
        node
        for node in semantic_manifest["nodes"]
        if node.get("node_kind") == "statement_row"
        and node.get("row_type") != "uncalculated"
        and node.get("formula_authority") != "intentionally_blank"
        and node.get("waterfall_stage") in ("pre_debt", "non_rcf_debt")
        and node.get("cash_effect") not in ("none", "balance", None)
    ]
    cash_component_parity_errors = []
    cash_financing_subtotal_row = next(
        (
            item["row"]
            for item in all_statement_rows
            if item.get("semantic_role") == "cash_from_financing"
        ),
        None,
    )
    cash_investing_subtotal_row = next(
        (
            item["row"]
            for item in all_statement_rows
            if item.get("semantic_role") == "cash_from_investing"
        ),
        None,
    )
    statement_rcf_nodes = [
        node
        for node in semantic_manifest["nodes"]
        if node.get("node_kind") == "statement_row"
        and node.get("row_type") != "uncalculated"
        and node.get("formula_authority") != "intentionally_blank"
        and node.get("movement_type") in ("rcf_draw", "rcf_repayment")
    ]
    debt_component_types = {
        "scheduled_amortisation",
        "maturity_repayment",
        "debt_issuance_cost",
        "other_cash_debt_movement",
        "acquisition_debt_proceeds",
        "acquisition_debt_repayment",
    }
    debt_proceeds_types = {"debt_issuance"}

    # DEFECT 0.14 — A CONSOLIDATED CONSTITUENT CANNOT ENTER ENDING CASH AT ALL,
    # AND ASKING IT TO IS NOT A TEST OF THE ECONOMICS.
    #
    # Until the Node source's `xmlCellFormula` regex was given a self-closing
    # branch this check was GREEN FOR THE WRONG REASON: asked for `J61` it
    # matched the self-closing `<c r="J61" …/>` OPEN tag, ran on to the NEXT
    # cell's `</c>` and returned that neighbour's formula, so the reference path
    # it "found" was scraped off a row it was not examining.  With the phantom
    # gone the check began reporting a real design mismatch.
    #
    # The mismatch: `row_plan.mjs` consolidates every Change-in-Debt constituent
    # — additions, repayments, issuance costs, commercial paper, other movements
    # and both revolver legs — onto one line and marks each constituent
    # `forecast_treatment: "uncalculated"`.  They are DELIBERATELY blank in the
    # forecast.  The movement reaches ending cash through the debt schedule, via
    # the waterfall's `pre_rcf_debt_cash_flow` and the RCF sweep, and the
    # consolidated face line links down to the same schedule.  So a constituent
    # enters the ending-cash path ZERO times BY DESIGN, and demanding it enter
    # once demands something the design guarantees will never happen.
    #
    # What replaces the demand is STRICTLY STRONGER, and stronger in the way
    # that matters: it stops counting references and starts reconciling numbers.
    # For every consolidated constituent the check now requires ALL of:
    #
    #   1. the cell really IS blank — a row declared `uncalculated` that still
    #      carries a formula or a cached value is a defect the old assertion
    #      could not see;
    #   2. it is referenced by NO waterfall row (the old form checked one bridge
    #      row; this checks all of them);
    #   3. it has exactly ONE declared parent, and that parent consolidates the
    #      WHOLE run — a half-consolidated subtotal is a defect;
    #   4. in the subtotal above, the parent appears EXACTLY ONCE and the
    #      constituent appears ZERO times — the consolidation is asserted rather
    #      than assumed;
    #   5. the parent's own value RECONCILES NUMERICALLY to the waterfall rows
    #      standing in for its constituents:
    #        change in debt == pre-RCF debt movement + RCF draw − RCF repayment;
    #   6. and each of those stand-in rows is a LIVE link — it carries a formula
    #      making at least one same-sheet reference — because (5) compares two
    #      numbers and cannot see a hardcode that happens to equal the right one.
    #
    # (5) is the assertion the reference count was a proxy for, and it is a
    # proxy no longer: a reference can be present while the number is wrong, but
    # this cannot pass on a workbook whose consolidated debt movement disagrees
    # with what the sweep pushes into ending cash.  (6) exists because the
    # deliberate-breakage run found the one thing (5) alone missed — see the note
    # at the loop itself.  Every LIVE cash component is still held to the
    # original "enters ending cash exactly once".
    statement_row_by_id = {item["row_id"]: item for item in all_statement_rows}
    statement_parents: Dict[str, List[dict]] = {}
    for definition in all_statement_rows:
        for reference in (definition.get("calculation") or {}).get("refs", []):
            statement_parents.setdefault(reference, []).append(definition)
    manifest_row_node_by_id = {
        node["row_id"]: node
        for node in semantic_manifest["nodes"]
        if node.get("node_kind") == "statement_row"
    }

    def is_consolidated_constituent(row_id) -> bool:
        definition = statement_row_by_id.get(row_id)
        return bool(
            definition
            and definition.get("forecast_treatment") == "uncalculated"
            and statement_parents.get(row_id)
        )

    consolidation_parents: List[dict] = []
    for node in cash_component_nodes + statement_rcf_nodes:
        if not is_consolidated_constituent(node.get("row_id")):
            continue
        parents = statement_parents.get(node["row_id"], [])
        if len(parents) != 1:
            continue
        if parents[0] not in consolidation_parents:
            consolidation_parents.append(parents[0])

    def consolidation_stand_in(column: str, constituent_row_ids):
        """Waterfall rows standing in, in the ending-cash path, for a run.

        One aggregate row covers every non-revolver debt movement, so it is
        counted once however many constituents map to it; the two revolver legs
        are separate rows and carry their own sign.
        """
        contributions = []
        untyped = []
        unresolved = []
        used_pre_rcf_bridge = [False]
        used_debt_proceeds_bridge = [False]

        def push(row_id, waterfall_id, sign):
            waterfall_row = waterfall_rows.get(waterfall_id)
            if not isinstance(waterfall_row, (int, float)):
                unresolved.append({"row_id": row_id, "waterfall_id": waterfall_id})
                return
            contributions.append(
                {
                    "row_id": row_id,
                    "waterfall_id": waterfall_id,
                    "address": "%s%s" % (column, waterfall_row),
                    "sign": sign,
                }
            )

        for row_id in constituent_row_ids:
            manifest_node = manifest_row_node_by_id.get(row_id) or {}
            if (
                manifest_node.get("row_type") == "uncalculated"
                or manifest_node.get("formula_authority") == "intentionally_blank"
            ):
                continue
            movement_type = manifest_node.get("movement_type")
            if movement_type == "rcf_draw":
                push(row_id, "rcf_draw_waterfall", 1)
            elif movement_type == "rcf_repayment":
                push(row_id, "rcf_repayment_waterfall", -1)
            elif movement_type == "lease_principal":
                push(row_id, "lease_principal_waterfall", 1)
            elif movement_type in debt_proceeds_types:
                if not used_debt_proceeds_bridge[0]:
                    used_debt_proceeds_bridge[0] = True
                    proceeds_row = waterfall_rows.get("non_rcf_debt_proceeds")
                    source_row = manifest_node.get("physical_row")
                    source_value = (
                        numeric(value("%s%s" % (column, source_row)))
                        if isinstance(source_row, (int, float))
                        else 0.0
                    )
                    if isinstance(proceeds_row, (int, float)):
                        push(row_id, "non_rcf_debt_proceeds", 1)
                    elif abs(source_value) > 1e-9:
                        unresolved.append(
                            {
                                "row_id": row_id,
                                "waterfall_id": "non_rcf_debt_proceeds",
                                "nonzero_source_value": source_value,
                            }
                        )
            elif movement_type in debt_component_types:
                if not used_pre_rcf_bridge[0]:
                    used_pre_rcf_bridge[0] = True
                    push(row_id, "pre_rcf_debt_cash_flow", 1)
            else:
                untyped.append({"row_id": row_id, "movement_type": movement_type})
        total = sum(
            item["sign"] * numeric(value(item["address"])) for item in contributions
        )
        return {
            "contributions": contributions,
            "untyped": untyped,
            "unresolved": unresolved,
            "total": total,
        }

    def audit_consolidated_constituent(column, node, waterfall_references):
        """Requirements (1)-(4) for one consolidated constituent in one column.

        `waterfall_references` is every same-sheet reference made by every
        waterfall row in this column, so (2) covers the whole sweep rather than
        a single bridge row.
        """
        errors = []
        address = "%s%s" % (column, node["physical_row"])
        emitted = cell_formula(address)
        cached = value(address)
        if emitted or (cached is not None and cached != ""):
            errors.append(
                {
                    "column": column,
                    "id": "consolidated_constituent_is_not_blank",
                    "semantic_id": node.get("semantic_id"),
                    "movement_type": node.get("movement_type"),
                    "address": address,
                    "emitted_formula": emitted or None,
                    "cached_value": cached,
                }
            )
        waterfall_hits = sum(
            1 for reference in waterfall_references if reference == address
        )
        if waterfall_hits != 0:
            errors.append(
                {
                    "column": column,
                    "id": "consolidated_constituent_still_referenced_by_waterfall",
                    "semantic_id": node.get("semantic_id"),
                    "address": address,
                    "reference_paths_from_ending_cash": waterfall_hits,
                }
            )
        parents = statement_parents.get(node["row_id"], [])
        if len(parents) != 1:
            errors.append(
                {
                    "column": column,
                    "id": "consolidated_constituent_without_unique_parent",
                    "semantic_id": node.get("semantic_id"),
                    "address": address,
                    "parents": [parent["row_id"] for parent in parents],
                }
            )
            return errors
        parent = parents[0]
        live_siblings = [
            reference
            for reference in (parent.get("calculation") or {}).get("refs", [])
            if not is_consolidated_constituent(reference)
        ]
        if live_siblings:
            errors.append(
                {
                    "column": column,
                    "id": "consolidation_parent_is_only_partly_consolidated",
                    "semantic_id": node.get("semantic_id"),
                    "parent_row_id": parent["row_id"],
                    "live_constituents": live_siblings,
                }
            )
        subtotals = statement_parents.get(parent["row_id"], [])
        if len(subtotals) != 1:
            errors.append(
                {
                    "column": column,
                    "id": "consolidation_parent_without_unique_subtotal",
                    "semantic_id": node.get("semantic_id"),
                    "parent_row_id": parent["row_id"],
                    "subtotals": [subtotal["row_id"] for subtotal in subtotals],
                }
            )
            return errors
        subtotal = subtotals[0]
        subtotal_address = "%s%s" % (column, subtotal["row"])
        subtotal_references = same_sheet_references(cell_formula(subtotal_address))
        parent_address = "%s%s" % (column, parent["row"])
        parent_count = sum(
            1 for reference in subtotal_references if reference == parent_address
        )
        constituent_count = sum(
            1 for reference in subtotal_references if reference == address
        )
        if parent_count != 1:
            errors.append(
                {
                    "column": column,
                    "id": "consolidation_parent_not_summed_once",
                    "parent_row_id": parent["row_id"],
                    "subtotal_row_id": subtotal["row_id"],
                    "subtotal_address": subtotal_address,
                    "parent_address": parent_address,
                    "occurrences": parent_count,
                }
            )
        if constituent_count != 0:
            errors.append(
                {
                    "column": column,
                    "id": "consolidated_constituent_still_summed_by_subtotal",
                    "semantic_id": node.get("semantic_id"),
                    "subtotal_row_id": subtotal["row_id"],
                    "subtotal_address": subtotal_address,
                    "address": address,
                    "occurrences": constituent_count,
                }
            )
        return errors

    # DEFECT 0.12.  These loops only ever PUSH errors, so an empty node set —
    # from a renamed movement_type, a manifest schema drift, or a plan that
    # emitted no waterfall — produced an empty error list and a green pass over
    # a workbook no cell of which was read.  Each loop counts what it actually
    # inspected, and the check requires the counts to be non-zero.
    cash_component_visited = 0
    waterfall_rows_visited = 0
    statement_rcf_visited = 0
    consolidated_constituent_visited = 0
    consolidation_tie_visited = 0
    consolidation_class = policy.class_for(
        "cfs-waterfall-component-parity", "currency"
    )
    for column in FORECAST_COLUMNS + PRO_FORMA_COLUMNS:
        waterfall_references_by_id = {
            waterfall_id: same_sheet_references(
                cell_formula("%s%s" % (column, waterfall_row))
            )
            for waterfall_id, waterfall_row in waterfall_rows.items()
        }
        all_waterfall_references = [
            reference
            for references in waterfall_references_by_id.values()
            for reference in references
        ]
        for node in cash_component_nodes:
            cash_component_visited += 1
            target_address = "%s%s" % (column, node["physical_row"])
            if is_consolidated_constituent(node.get("row_id")):
                consolidated_constituent_visited += 1
                cash_component_parity_errors.extend(
                    audit_consolidated_constituent(
                        column, node, all_waterfall_references
                    )
                )
                continue
            debt_component = node.get("movement_type") in debt_component_types
            debt_proceeds_component = (
                node.get("movement_type") in debt_proceeds_types
            )
            if debt_proceeds_component and not isinstance(
                waterfall_rows.get("non_rcf_debt_proceeds"), (int, float)
            ):
                source_value = numeric(value(target_address))
                if abs(source_value) > 1e-9:
                    cash_component_parity_errors.append(
                        {
                            "column": column,
                            "id": "nonzero_debt_proceeds_missing_visible_waterfall_row",
                            "row_id": node.get("row_id"),
                            "address": target_address,
                            "actual": source_value,
                        }
                    )
                continue
            if node.get("movement_type") == "lease_principal":
                bridge_address = "%s%s" % (
                    column,
                    waterfall_rows["lease_principal_waterfall"],
                )
            elif debt_proceeds_component:
                bridge_address = "%s%s" % (
                    column,
                    waterfall_rows["non_rcf_debt_proceeds"],
                )
            elif debt_component:
                bridge_address = "%s%s" % (
                    column,
                    waterfall_rows["pre_rcf_debt_cash_flow"],
                )
            else:
                bridge_address = "%s%s" % (column, waterfall_rows["cash_before_debt"])
            if (
                node.get("cash_flow_classification") == "investing"
                and cash_investing_subtotal_row
            ):
                path_count = reference_path_count(
                    "%s%s" % (column, cash_investing_subtotal_row), target_address
                )
            else:
                bridge_references = same_sheet_references(cell_formula(bridge_address))
                path_count = sum(
                    1 for reference in bridge_references if reference == target_address
                )
            if path_count != 1:
                cash_component_parity_errors.append(
                    {
                        "column": column,
                        "semantic_id": node.get("semantic_id"),
                        "movement_type": node.get("movement_type"),
                        "target_address": target_address,
                        "reference_paths_from_ending_cash": path_count,
                    }
                )
        for waterfall_id, waterfall_row in waterfall_rows.items():
            waterfall_rows_visited += 1
            address = "%s%s" % (column, waterfall_row)
            references = waterfall_references_by_id.get(waterfall_id, [])
            if cash_financing_subtotal_row and (
                "%s%s" % (column, cash_financing_subtotal_row) in references
            ):
                cash_component_parity_errors.append(
                    {
                        "column": column,
                        "waterfall_id": waterfall_id,
                        "id": "financing_subtotal_used_in_waterfall",
                        "address": address,
                    }
                )
            for rcf_node in statement_rcf_nodes:
                if "%s%s" % (column, rcf_node["physical_row"]) in references:
                    cash_component_parity_errors.append(
                        {
                            "column": column,
                            "waterfall_id": waterfall_id,
                            "id": "statement_rcf_used_to_calculate_waterfall",
                            "address": address,
                            "statement_rcf_row": rcf_node["physical_row"],
                        }
                    )
        for rcf_node in statement_rcf_nodes:
            statement_rcf_visited += 1
            if is_consolidated_constituent(rcf_node.get("row_id")):
                consolidated_constituent_visited += 1
                cash_component_parity_errors.extend(
                    audit_consolidated_constituent(
                        column, rcf_node, all_waterfall_references
                    )
                )
                continue
            expected_mechanical_row = (
                waterfall_rows["rcf_draw_waterfall"]
                if rcf_node.get("movement_type") == "rcf_draw"
                else waterfall_rows["rcf_repayment_waterfall"]
            )
            address = "%s%s" % (column, rcf_node["physical_row"])
            references = same_sheet_references(cell_formula(address))
            expected_reference = "%s%s" % (column, expected_mechanical_row)
            if sum(1 for item in references if item == expected_reference) != 1:
                cash_component_parity_errors.append(
                    {
                        "column": column,
                        "id": "cfs_rcf_not_linked_once_to_waterfall",
                        "movement_type": rcf_node.get("movement_type"),
                        "address": address,
                        "expected_reference": expected_reference,
                    }
                )
        # Requirement (5): the consolidated line must reconcile, as a NUMBER, to
        # the waterfall rows that carry its constituents into ending cash.
        for parent in consolidation_parents:
            consolidation_tie_visited += 1
            parent_address = "%s%s" % (column, parent["row"])
            if not cell_formula(parent_address):
                cash_component_parity_errors.append(
                    {
                        "column": column,
                        "id": "consolidation_parent_carries_no_formula",
                        "parent_row_id": parent["row_id"],
                        "address": parent_address,
                    }
                )
            stand_in = consolidation_stand_in(
                column, (parent.get("calculation") or {}).get("refs", [])
            )
            if stand_in["untyped"]:
                cash_component_parity_errors.append(
                    {
                        "column": column,
                        "id": "consolidated_constituent_has_no_waterfall_stand_in",
                        "parent_row_id": parent["row_id"],
                        "constituents": stand_in["untyped"],
                    }
                )
            if stand_in["unresolved"]:
                cash_component_parity_errors.append(
                    {
                        "column": column,
                        "id": "waterfall_stand_in_row_missing",
                        "parent_row_id": parent["row_id"],
                        "constituents": stand_in["unresolved"],
                    }
                )
                continue
            if not stand_in["contributions"]:
                continue
            # A NUMERIC TIE CANNOT SEE A HARDCODE THAT HAPPENS TO BE RIGHT.
            #
            # Requirement (5) compares two numbers, so on a case whose debt
            # movement is exactly zero — standard-net-cash is one — replacing the
            # sweep's debt bridge with a literal `0` changes nothing the
            # comparison can read, and the tie holds over a waterfall that has
            # stopped reading the debt schedule at all.  That is a real defect (a
            # hardcode where a link belongs) and it was MISSED, once, in the
            # deliberate-breakage run that found it.
            #
            # So the stand-in rows are also required to be LIVE: each must carry
            # a formula, and that formula must make at least one same-sheet
            # reference.  A constant has none.  Structural, not numeric, so it
            # does not care what the number happens to be.
            for contribution in stand_in["contributions"]:
                # Gross issuance cannot offset itself.  A zero proceeds bridge
                # has no active issuance contributor and may validly be `=0`;
                # any non-zero proceeds row must remain a live schedule link.
                if (
                    contribution["waterfall_id"] == "non_rcf_debt_proceeds"
                    and abs(numeric(value(contribution["address"]))) <= 1e-9
                ):
                    continue
                stand_in_formula = cell_formula(contribution["address"])
                if not same_sheet_references(stand_in_formula):
                    cash_component_parity_errors.append(
                        {
                            "column": column,
                            "id": "waterfall_stand_in_is_not_a_live_link",
                            "parent_row_id": parent["row_id"],
                            "waterfall_id": contribution["waterfall_id"],
                            "address": contribution["address"],
                            "emitted_formula": stand_in_formula or None,
                        }
                    )
            actual = numeric(value(parent_address))
            if not policy.equal(actual, stand_in["total"], consolidation_class):
                cash_component_parity_errors.append(
                    {
                        "column": column,
                        "id": "consolidation_does_not_reconcile_to_waterfall",
                        "parent_row_id": parent["row_id"],
                        "address": parent_address,
                        "actual": actual,
                        "expected": stand_in["total"],
                        "tolerance": policy.allowance(
                            consolidation_class, actual, stand_in["total"]
                        ),
                        "stand_in": [
                            {
                                "row_id": item["row_id"],
                                "waterfall_id": item["waterfall_id"],
                                "address": item["address"],
                                "sign": item["sign"],
                                "value": numeric(value(item["address"])),
                            }
                            for item in stand_in["contributions"]
                        ],
                    }
                )
    # A consolidation the check found constituents for but never reconciled is a
    # scan that stopped looking.  See DEFECT 0.12.
    cash_component_parity_visited = (
        cash_component_visited > 0
        and waterfall_rows_visited > 0
        and statement_rcf_visited > 0
        and (consolidated_constituent_visited == 0 or consolidation_tie_visited > 0)
    )
    checks.append(
        record(
            "cfs-waterfall-component-parity",
            cash_component_parity_visited
            and len(cash_component_parity_errors) == 0,
            (
                "Every live CFS cash component enters ending cash exactly once, "
                "and every consolidated constituent is blank, unreferenced by "
                "the sweep, summed once through its parent, and reconciles as a "
                "number to the waterfall rows that carry it."
            )
            if cash_component_parity_visited
            else (
                "One of the CFS parity scans inspected ZERO rows — the check "
                "cannot pass on an empty visit."
            ),
            {
                "visited": {
                    "cash_components": cash_component_visited,
                    "waterfall_rows": waterfall_rows_visited,
                    "statement_rcf_rows": statement_rcf_visited,
                    "consolidated_constituents": consolidated_constituent_visited,
                    "consolidation_ties": consolidation_tie_visited,
                },
                "errors": cash_component_parity_errors[:100],
            },
            violations=(
                len(cash_component_parity_errors)
                or (0 if cash_component_parity_visited else 1)
            ),
        )
    )

    # ---------------------------------------------------- liquidity-certification
    liquidity_mechanic_errors = []
    permitted_capacity_shortfalls = []
    statement_ending_cash_row = main_cash_row
    for index, forecast_column in enumerate(FORECAST_COLUMNS):
      for column in (forecast_column, PRO_FORMA_COLUMNS[index]):
        solution_period = (
            solution["standalone"]["forecast"][index]
            if column == forecast_column
            else solution["pro_forma"]["forecast"][index]
        )
        draw = numeric(value("%s%s" % (column, waterfall_rows["rcf_draw_waterfall"])))
        repayment = numeric(
            value("%s%s" % (column, waterfall_rows["rcf_repayment_waterfall"]))
        )
        shortfall = max(
            0.0,
            numeric(value("%s%s" % (column, waterfall_rows["minimum_cash"])))
            - numeric(value("%s%s" % (column, balancing_cash_row))),
        )
        liquidity_class = policy.class_for("liquidity-certification", "currency")
        if policy.exceeds(draw, liquidity_class) and policy.exceeds(
            repayment, liquidity_class
        ):
            liquidity_mechanic_errors.append(
                {
                    "column": column,
                    "id": "draw_repay_mutual_exclusivity",
                    "draw": draw,
                    "repayment": repayment,
                }
            )
        if policy.exceeds(shortfall, liquidity_class):
            capacity_native = solution_period.get("rcf_capacity_native")
            ending_native = solution_period.get("rcf_ending_native")
            capacity_evidence_present = (
                capacity_native is not None
                and ending_native is not None
                and math.isfinite(float(capacity_native))
                and math.isfinite(float(ending_native))
            )
            if not capacity_evidence_present or not policy.equal(
                numeric(ending_native), numeric(capacity_native), liquidity_class
            ):
                liquidity_mechanic_errors.append(
                    {
                        "column": column,
                        "id": "liquidity_shortfall_with_spare_capacity",
                        "shortfall": shortfall,
                        "ending_rcf_native": (
                            numeric(ending_native)
                            if capacity_evidence_present
                            else None
                        ),
                        "rcf_capacity_native": (
                            numeric(capacity_native)
                            if capacity_evidence_present
                            else None
                        ),
                    }
                )
            else:
                permitted_capacity_shortfalls.append(
                    {
                        "column": column,
                        "shortfall": shortfall,
                        "ending_rcf_native": numeric(ending_native),
                        "rcf_capacity_native": numeric(capacity_native),
                    }
                )
    checks.append(
        record(
            "liquidity-certification",
            len(liquidity_mechanic_errors) == 0,
            "RCF draw and repayment are mutually exclusive; minimum cash is met "
            "whenever capacity permits, and residual shortfall is retained only "
            "when RCF capacity is exhausted.",
            {
                "permitted_capacity_shortfalls": permitted_capacity_shortfalls,
                "errors": liquidity_mechanic_errors,
            },
            violations=len(liquidity_mechanic_errors),
        )
    )

    # ------------------------------------------------------- control-formula-gates
    gate_errors = []
    gate_token = "$C$%s=0" % row_plan["controls"]["circularity"]
    roll_token = "$C$%s=1" % row_plan["controls"]["debt_maturities_roll"]
    circularity_on = numeric(value("C%s" % row_plan["controls"]["circularity"])) == 1

    def is_structural_zero(address: str) -> bool:
        text = cell_formula(address)
        if not text:
            return numeric(value(address)) == 0
        masked = re.sub(
            r"\$?[A-Z]{1,3}\$?\d+", "R", re.sub(r"\s+", "", re.sub(r"^=", "", text))
        )
        return bool(re.match(r"^0$", masked)) or bool(
            re.match(r"^(IF\(R=0,0,)+0\)+$", masked)
        )

    gated_cache: Dict[str, bool] = {}

    def is_gated(address: str, depth: int = 0) -> bool:
        if address in gated_cache:
            return gated_cache[address]
        if depth > 4:
            return False
        text = cell_formula(address)
        if not text:
            return False
        result = gate_token in text
        if not result:
            body = re.sub(r"\s+", "", re.sub(r"^=", "", text))
            if re.match(r"^\$?[A-Z]{1,3}\$?\d+([+-]\$?[A-Z]{1,3}\$?\d+)*$", body):
                references = [
                    item.replace("$", "")
                    for item in re.findall(r"\$?[A-Z]{1,3}\$?\d+", body)
                ]
                gated_references = [
                    item for item in references if is_gated(item, depth + 1)
                ]
                result = len(gated_references) > 0 and all(
                    reference in gated_references or is_structural_zero(reference)
                    for reference in references
                )
        gated_cache[address] = result
        return result

    component_rows = [
        {
            "id": "instrument_interest.%s" % plan["instrument_id"],
            "row": plan["interest_row"],
        }
        for plan in row_plan["instruments"]
        if isinstance(plan.get("interest_row"), int)
    ] + [
        {
            "id": "instrument_pik_interest.%s" % plan["instrument_id"],
            "row": plan["pik_interest_row"],
        }
        for plan in row_plan["instruments"]
        if isinstance(plan.get("pik_interest_row"), int)
    ] + [
        {
            "id": "cash_bucket_interest.%s" % plan["bucket_id"],
            "row": plan["interest_row"],
        }
        for plan in row_plan.get("cash_buckets", [])
        if isinstance(plan.get("interest_row"), int)
    ] + [
        {"id": identifier, "row": interest_rows[identifier]}
        for identifier in (
            "rcf_interest",
            "rcf_commitment_fee",
            "lease_interest",
            "other_unallocated_interest",
            "non_cash_interest",
            "interest_income_schedule",
        )
    ]
    pik_principal_rows = [
        {
            "id": "instrument_pik_accretion.%s" % plan["instrument_id"],
            "row": plan["pik_row"],
        }
        for plan in row_plan["instruments"]
        if isinstance(plan.get("pik_row"), int)
    ]
    for entry in component_rows:
        for column in FORECAST_COLUMNS + PRO_FORMA_COLUMNS:
            address = "%s%s" % (column, entry["row"])
            if not is_gated(address):
                gate_errors.append(
                    {
                        "address": address,
                        "issue": "%s_missing_circularity_gate" % entry["id"],
                        "formula": cell_formula(address),
                    }
                )
    for entry in pik_principal_rows:
        for column in FORECAST_COLUMNS + PRO_FORMA_COLUMNS:
            address = "%s%s" % (column, entry["row"])
            if not is_gated(address):
                gate_errors.append(
                    {
                        "address": address,
                        "issue": "%s_missing_circularity_gate" % entry["id"],
                        "formula": cell_formula(address),
                    }
                )
        for column in ADJUSTMENT_COLUMNS:
            address = "%s%s" % (column, entry["row"])
            if not is_gated(address) and not is_structural_zero(address):
                gate_errors.append(
                    {
                        "address": address,
                        "issue": "%s_adjustment_missing_circularity_gate" % entry["id"],
                        "formula": cell_formula(address),
                    }
                )
    for column in PRO_FORMA_COLUMNS:
        address = "%s%s" % (column, interest_rows["acquisition_interest"])
        if not is_gated(address):
            gate_errors.append(
                {
                    "address": address,
                    "issue": "acquisition_interest_missing_circularity_gate",
                    "formula": cell_formula(address),
                }
            )
    component_rows_plus_acquisition = component_rows + [
        {"id": "acquisition_interest", "row": interest_rows["acquisition_interest"]}
    ]
    for entry in component_rows_plus_acquisition:
        for column in ADJUSTMENT_COLUMNS:
            address = "%s%s" % (column, entry["row"])
            if not is_gated(address) and not is_structural_zero(address):
                gate_errors.append(
                    {
                        "address": address,
                        "issue": "%s_adjustment_missing_circularity_gate" % entry["id"],
                        "formula": cell_formula(address),
                    }
                )
    for entry in component_rows_plus_acquisition:
        for column in FORECAST_COLUMNS + PRO_FORMA_COLUMNS:
            address = "%s%s" % (column, entry["row"])
            text = cell_formula(address)
            if gate_token not in text:
                continue
            body = text[text.index(gate_token) + len(gate_token) :]
            calculation = re.sub(r"^,0,", "", body)
            references_cells = bool(
                re.search(
                    r"\$?[A-Z]{1,3}\$?\d+",
                    re.sub(
                        r"\$C\$%s\b" % row_plan["controls"]["circularity"],
                        "",
                        calculation,
                    ),
                )
            )
            has_curve = bool(re.search(r"Forward Curves", calculation, re.I))
            if not references_cells and not has_curve:
                gate_errors.append(
                    {
                        "address": address,
                        "issue": "%s_gate_wraps_no_calculation" % entry["id"],
                        "formula": text,
                    }
                )
    interest_face_rows = (
        [entry["row"] for entry in component_rows]
        + [entry["row"] for entry in pik_principal_rows]
        + [
            interest_rows["acquisition_interest"],
            interest_rows["rcf_total_fees"],
            interest_rows["gross_interest_expense"],
            interest_rows["net_interest_expense"],
            interest_rows["cash_interest_paid"],
        ]
    )
    if not circularity_on:
        for row in interest_face_rows:
            for column in FORECAST_COLUMNS + ADJUSTMENT_COLUMNS + PRO_FORMA_COLUMNS:
                address = "%s%s" % (column, row)
                cached = numeric(value(address))
                if abs(cached) > 1e-9:
                    gate_errors.append(
                        {
                            "address": address,
                            "issue": "forecast_interest_not_zero_with_circularity_off",
                            "cached": cached,
                        }
                    )
    else:
        live = any(
            abs(numeric(value(address))) > 1e-9
            for address in (
                ["%s%s" % (c, interest_rows["gross_interest_expense"]) for c in FORECAST_COLUMNS]
                + ["%s%s" % (c, interest_rows["interest_income_schedule"]) for c in FORECAST_COLUMNS]
            )
        )
        if not live:
            gate_errors.append(
                {
                    "address": "J%s" % interest_rows["gross_interest_expense"],
                    "issue": "circularity_on_but_interest_solution_is_zero",
                }
            )
    for plan in row_plan["instruments"]:
        if not isinstance(plan.get("interest_row"), int):
            continue
        interest_formula = cell_formula("J%s" % plan["interest_row"])
        is_rcf = bool(re.search(r"rcf|revolv", plan["instrument_id"], re.I)) or (
            ("J%s" % interest_rows["rcf_interest"]) in interest_formula
        )
        if is_rcf:
            continue
        if str(plan["debt_row"]) not in interest_formula:
            gate_errors.append(
                {
                    "address": "J%s" % plan["interest_row"],
                    "issue": "interest_does_not_reference_debt_schedule",
                    "formula": interest_formula,
                }
            )
        balance_formula = cell_formula("J%s" % plan["debt_row"])
        # Use the same semantic maturity distinction as the emitter and the
        # independent JavaScript validator.  A contractual term maturity is
        # governed by the roll switch; a documented evergreen/non-maturing
        # balance deliberately is not.  Never infer this from its label or row.
        governed_by_maturity_roll = (
            plan.get("maturity_treatment") != "non_maturing_within_forecast"
        )
        if (
            governed_by_maturity_roll
            and balance_formula
            and roll_token not in balance_formula
        ):
            gate_errors.append(
                {
                    "address": "J%s" % plan["debt_row"],
                    "issue": "debt_balance_not_gated_by_maturity_roll",
                    "formula": balance_formula,
                }
            )
        if (
            not governed_by_maturity_roll
            and balance_formula
            and roll_token in balance_formula
        ):
            gate_errors.append(
                {
                    "address": "J%s" % plan["debt_row"],
                    "issue": "non_maturing_balance_incorrectly_gated_by_maturity_roll",
                    "formula": balance_formula,
                }
            )
    checks.append(
        record(
            "control-formula-gates",
            len(gate_errors) == 0,
            "Circularity is a kill switch: every forecast interest-expense and "
            "interest-income component is gated with its arithmetic intact and its "
            "caches agree with the control state; maturity roll gates the visible "
            "debt balance.",
            gate_errors[:100],
            violations=len(gate_errors),
        )
    )

    # --------------------------------- visible-interest-assumption-references
    visible_assumption_errors = []
    visible_rate_assumption_rows = set(
        list((row_plan.get("benchmark_floor_rows") or {}).values())
        + list((row_plan.get("pik_rate_rows") or {}).values())
        + [
            plan.get("rate_row")
            for plan in row_plan.get("cash_buckets", [])
            if isinstance(plan.get("rate_row"), int)
        ]
    )
    interest_formula_rows = [
        {
            "id": "instrument_interest.%s" % plan["instrument_id"],
            "row": plan["interest_row"],
        }
        for plan in row_plan["instruments"]
    ] + [
        {
            "id": "instrument_pik_interest.%s" % plan["instrument_id"],
            "row": plan["pik_interest_row"],
        }
        for plan in row_plan["instruments"]
        if isinstance(plan.get("pik_interest_row"), int)
    ] + [
        {
            "id": "cash_bucket_interest.%s" % plan["bucket_id"],
            "row": plan["interest_row"],
        }
        for plan in row_plan.get("cash_buckets", [])
        if isinstance(plan.get("interest_row"), int)
    ] + pik_principal_rows + [
        {"id": identifier, "row": interest_rows[identifier]}
        for identifier in (
            "rcf_interest",
            "rcf_commitment_fee",
            "lease_interest",
            "other_unallocated_interest",
            "non_cash_interest",
            "interest_income_schedule",
        )
    ]
    for entry in interest_formula_rows:
        for column in FORECAST_COLUMNS + PRO_FORMA_COLUMNS:
            address = "%s%s" % (column, entry["row"])
            formula_text = cell_formula(address)
            closure = formula_closure(address)
            embedded = [
                dict(item, formula_address=address)
                for item in embedded_rate_literals(formula_text)
            ]
            if embedded:
                visible_assumption_errors.append(
                    {
                        "id": entry["id"],
                        "address": address,
                        "issue": "embedded_numeric_assumption",
                        "embedded": embedded,
                        "formula": formula_text,
                    }
                )
            if column in FORECAST_COLUMNS:
                visible_references = []
                for reference in closure["references"]:
                    match = re.match(r"^([A-Z]+)(\d+)$", reference)
                    if not match:
                        continue
                    reference_column = match.group(1)
                    reference_row = int(match.group(2))
                    if (
                        reference_column in ("C", "D", "E")
                        and reference_row >= row_plan["interest_term_header_row"]
                    ) or (
                        reference_column in FORECAST_COLUMNS + PRO_FORMA_COLUMNS
                        and reference_row in visible_rate_assumption_rows
                    ) or (
                        reference_column == "P"
                        and reference_row < row_plan["period_group_row"]
                    ):
                        visible_references.append(reference)
                has_forward_curve_reference = any(
                    re.search(
                        r"(?:'Forward Curves'|Forward_Curves|Forward Curves)!",
                        item["formula"],
                        re.I,
                    )
                    for item in closure["formulas"]
                )
                if (
                    formula_text
                    and not visible_references
                    and not has_forward_curve_reference
                ):
                    visible_assumption_errors.append(
                        {
                            "id": entry["id"],
                            "address": address,
                            "issue": "no_visible_assumption_reference",
                            "formula": formula_text,
                        }
                    )
    for column in PRO_FORMA_COLUMNS:
        address = "%s%s" % (column, interest_rows["acquisition_interest"])
        formula_text = cell_formula(address)
        closure = formula_closure(address)
        embedded = [
            dict(item, formula_address=address)
            for item in embedded_rate_literals(formula_text)
        ]
        visible_references = [
            reference
            for reference in closure["references"]
            if re.match(r"^P\d+$", reference)
        ]
        if embedded or not visible_references:
            visible_assumption_errors.append(
                {
                    "id": "acquisition_interest",
                    "address": address,
                    "issue": "embedded_numeric_assumption"
                    if embedded
                    else "no_visible_assumption_reference",
                    "embedded": embedded,
                    "formula": formula_text,
                }
            )
    checks.append(
        record(
            "visible-interest-assumption-references",
            len(visible_assumption_errors) == 0,
            "Interest formulas reference visible term, control or curve inputs and "
            "contain no embedded rate or plug assumptions.",
            visible_assumption_errors[:100],
            violations=len(visible_assumption_errors),
        )
    )

    # ------------------------------------------------------ independent-solver-parity
    solver_errors = []
    for block, columns in (
        (solution["standalone"], FORECAST_COLUMNS),
        (solution["pro_forma"], PRO_FORMA_COLUMNS),
    ):
        for index in range(3):
            result = block["forecast"][index]
            column = columns[index]
            comparisons = [
                (
                    "cash_flow_cash",
                    value("%s%s" % (column, statement_ending_cash_row)),
                    result.get(
                        "cash_flow_cash",
                        result.get("reported_cash", result.get("ending_cash")),
                    ),
                    "currency",
                ),
                (
                    "ending_cash",
                    value("%s%s" % (column, balancing_cash_row)),
                    result.get("ending_cash"),
                    "currency",
                ),
                (
                    "ending_rcf",
                    value("%s%s" % (column, waterfall_rows["ending_rcf"])),
                    result.get("ending_rcf"),
                    "currency",
                ),
                (
                    "gross_interest",
                    -numeric(
                        value("%s%s" % (column, interest_rows["gross_interest_expense"]))
                    ),
                    result.get("gross_interest"),
                    "currency",
                ),
                (
                    "interest_income",
                    value("%s%s" % (column, interest_rows["interest_income_schedule"])),
                    result.get("interest_income"),
                    "currency",
                ),
                (
                    "net_leverage",
                    value("%s%s" % (column, debt_rows["net_debt_to_adjusted_ebitda"])),
                    result.get("net_leverage"),
                    "ratio",
                ),
                (
                    "total_liquidity",
                    value("%s%s" % (column, debt_rows["total_liquidity"])),
                    result.get("total_liquidity"),
                    "currency",
                ),
                (
                    "rcf_draw",
                    value("%s%s" % (column, waterfall_rows["rcf_draw_waterfall"])),
                    result.get("rcf_draw"),
                    "currency",
                ),
                (
                    "rcf_repayment",
                    value(
                        "%s%s"
                        % (column, waterfall_rows["rcf_repayment_waterfall"])
                    ),
                    result.get("rcf_repayment"),
                    "currency",
                ),
                (
                    "rcf_interest",
                    -numeric(value("%s%s" % (column, interest_rows["rcf_interest"]))),
                    result.get("rcf_interest"),
                    "currency",
                ),
                (
                    "rcf_commitment_fee",
                    -numeric(
                        value("%s%s" % (column, interest_rows["rcf_commitment_fee"]))
                    ),
                    result.get("rcf_commitment_fee"),
                    "currency",
                ),
                (
                    "undrawn_rcf",
                    value("%s%s" % (column, debt_rows["undrawn_rcf"])),
                    result.get("undrawn_rcf"),
                    "currency",
                ),
            ]
            if isinstance(debt_rows.get("reported_cash"), int):
                comparisons.append(
                    (
                        "reported_cash_summary",
                        value("%s%s" % (column, debt_rows["reported_cash"])),
                        result.get("reported_cash", result.get("ending_cash")),
                        "currency",
                    )
                )
            if isinstance(debt_rows.get("liquidity_cash"), int):
                comparisons.append(
                    (
                        "liquidity_cash",
                        value("%s%s" % (column, debt_rows["liquidity_cash"])),
                        result.get("liquidity_cash", result.get("ending_cash")),
                        "currency",
                    )
                )
            if isinstance(debt_rows.get("cash_for_net_debt"), int):
                comparisons.append(
                    (
                        "net_debt_eligible_cash",
                        value("%s%s" % (column, debt_rows["cash_for_net_debt"])),
                        -numeric(result.get("eligible_cash", result.get("ending_cash"))),
                        "currency",
                    )
                )
            if isinstance(debt_rows.get("interest_bearing_cash"), int):
                comparisons.append(
                    (
                        "interest_eligible_cash",
                        value("%s%s" % (column, debt_rows["interest_bearing_cash"])),
                        result.get("interest_eligible_cash", result.get("ending_cash")),
                        "currency",
                    )
                )
            for metric, actual, expected, metric_class in comparisons:
                metric_class = policy.class_for(
                    "independent-solver-parity", metric_class
                )
                if not equal(actual, expected, metric_class):
                    solver_errors.append(
                        {
                            "column": column,
                            "metric": metric,
                            "metric_class": metric_class,
                            "actual": actual,
                            "expected": expected,
                            "difference": abs(numeric(actual) - numeric(expected)),
                            "allowance": policy.allowance(metric_class, actual, expected),
                        }
                    )
    checks.append(
        record(
            "independent-solver-parity",
            len(solver_errors) == 0 and solution.get("all_checks_pass") is True,
            "Saved workbook values match the independent solver in standalone and "
            "pro forma.",
            {
                "solver_all_checks_pass": solution.get("all_checks_pass"),
                "tolerance_policy": policy.describe(),
                "differences": solver_errors,
            },
            violations=len(solver_errors)
            + (0 if solution.get("all_checks_pass") is True else 1),
        )
    )

    # ------------------------------------------------------------- manual checks
    expected_native_bindings = build_native_evidence_bindings(
        case_id=solution.get("case_id"),
        case_sha256=semantic_manifest.get("case_sha256"),
        workbook_bytes=workbook_buffer,
        semantic_manifest_bytes=semantic_manifest_text.encode("utf-8"),
        row_map_bytes=row_map_buffer,
    )
    native_evidence_errors = (
        validate_native_evidence(finance_review.get("data"), expected_native_bindings)
        if finance_review.get("data")
        else []
    )
    native_evidence_passed = finance_review["passed"] and not native_evidence_errors
    checks.append(
        record(
            "native-excel-toggle-restoration",
            native_evidence_passed,
            "Passing native Excel on/off/on/off/on evidence is hash-bound to this "
            "case, manifest and workbook."
            if native_evidence_passed
            else (
                "The supplied native Excel evidence is incomplete or belongs to a "
                "different build."
                if finance_review["supplied"]
                else "Native Excel on/off/on/off/on restoration remains required."
            ),
            {
                "review": finance_review.get("evidence"),
                "expected_bindings": expected_native_bindings,
                "errors": native_evidence_errors,
            },
            status=("pass" if native_evidence_passed else "fail")
            if finance_review["supplied"]
            else "manual",
            violations=len(native_evidence_errors) if finance_review["supplied"] else 0,
        )
    )
    checks.append(
        record(
            "visual-review",
            visual_review["passed"],
            "Passing visual-review evidence was supplied."
            if visual_review["passed"]
            else (
                "The supplied visual-review evidence is empty or has not passed."
                if visual_review["supplied"]
                else "A human visual review remains required."
            ),
            visual_review.get("evidence"),
            status=("pass" if visual_review["passed"] else "fail")
            if visual_review["supplied"]
            else "manual",
            violations=0,
        )
    )

    # ------------------------------------------------------------------- report
    failures = [item for item in checks if item["status"] == "fail"]
    manual = [item for item in checks if item["status"] == "manual"]
    total_violations = sum(item["violations"] for item in checks)
    status = (
        "FAIL"
        if failures
        else ("PASS_PENDING_MANUAL" if manual else "PASS")
    )
    report = {
        "schema_version": 1,
        "validator": "excel-inflow-v2-python",
        "port_of": "scripts/validate_dynamic_model.mjs",
        "workbook": input_path,
        "status": status,
        "total_violations": total_violations,
        "tolerance_mode": mode,
        "tolerance_override": policy.describe().get("tolerance_override"),
        "tolerance_policy": policy.describe(),
        "summary": {
            "passed": sum(1 for item in checks if item["status"] == "pass"),
            "failed": len(failures),
            "manual": len(manual),
            "total_violations": total_violations,
        },
        "checks": checks,
    }
    with open(
        os.path.join(output_directory, "validation-report.json"), "w", encoding="utf-8"
    ) as handle:
        handle.write(json.dumps(report, indent=2, default=str) + "\n")
    with open(
        os.path.join(output_directory, "validation-report.md"), "w", encoding="utf-8"
    ) as handle:
        lines = [
            "# Excel Inflow v2 validation (Python port)",
            "",
            "Status: **%s**" % status,
            "",
            "Total violations: **%d** across %d failing checks."
            % (total_violations, len(failures)),
            "",
        ]
        lines += [
            "- %s -- %s: %s" % (item["status"].upper(), item["id"], item["message"])
            for item in checks
        ]
        lines.append("")
        handle.write("\n".join(lines))

    # Requirement: report exit status and TOTAL violation count, never a
    # sub-metric.  Three agents once reported a sub-metric while the validator
    # was exiting FAIL and a 24-cell defect stayed hidden for hours.
    print(
        "STATUS=%s exit=%d checks_failed=%d checks_manual=%d total_violations=%d"
        % (status, 1 if failures else 0, len(failures), len(manual), total_violations)
    )
    if failures:
        print(
            "FAILING CHECKS: "
            + ", ".join("%s(%d)" % (item["id"], item["violations"]) for item in failures)
        )
    print(os.path.join(output_directory, "validation-report.json"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
