"""A deliberately small evaluator for conditional-formatting rule predicates.

Conditional formatting is the one class of defect where XML inspection is
actively misleading: a rule with a broken formula is *declared* correctly and
silently does nothing.  Confirming the rule exists proves nothing.

To assert that a rule FIRES we need to know which cells it should apply to.
This module evaluates the restricted formula grammar the emitter actually uses
-- comparisons of cell references and literals, combined with AND / OR / NOT --
against the workbook's cached values.  Anything outside that grammar returns
``None`` (undetermined) and is reported as such.  It is never silently treated
as "did not fire", because that would hide exactly the defect we are hunting.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple, Union

from . import xlsx_model as xm

Value = Union[float, str, bool, None]

_TOKEN_RE = re.compile(
    r"""\s*(?:
        (?P<string>"(?:[^"]|"")*")
      | (?P<number>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)
      | (?P<ref>\$?[A-Z]{1,3}\$?\d+)
      | (?P<func>[A-Z_][A-Z0-9_.]*)\s*(?=\()
      | (?P<op><>|<=|>=|[=<>+\-*/&,()])
    )""",
    re.VERBOSE,
)


class Undetermined(Exception):
    pass


@dataclass
class Token:
    kind: str
    text: str


def tokenise(formula: str) -> List[Token]:
    tokens: List[Token] = []
    pos = 0
    text = formula.strip()
    while pos < len(text):
        match = _TOKEN_RE.match(text, pos)
        if not match:
            raise Undetermined("unparseable at %r" % text[pos:pos + 12])
        pos = match.end()
        for kind in ("string", "number", "ref", "func", "op"):
            if match.group(kind) is not None:
                tokens.append(Token(kind, match.group(kind)))
                break
    return tokens


class _Parser:
    def __init__(self, tokens: List[Token], resolve: Callable[[str], Value]):
        self.tokens = tokens
        self.i = 0
        self.resolve = resolve

    def peek(self) -> Optional[Token]:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def take(self) -> Token:
        token = self.tokens[self.i]
        self.i += 1
        return token

    def expect(self, text: str) -> None:
        token = self.peek()
        if token is None or token.text != text:
            raise Undetermined("expected %r" % text)
        self.i += 1

    def parse(self) -> Value:
        value = self.comparison()
        if self.peek() is not None:
            raise Undetermined("trailing tokens")
        return value

    def comparison(self) -> Value:
        left = self.concat()
        token = self.peek()
        if token is not None and token.kind == "op" and token.text in ("=", "<>", "<", "<=", ">", ">="):
            op = self.take().text
            right = self.concat()
            return _compare(op, left, right)
        return left

    def concat(self) -> Value:
        value = self.additive()
        while True:
            token = self.peek()
            if token is not None and token.text == "&":
                self.take()
                value = _as_text(value) + _as_text(self.additive())
            else:
                return value

    def additive(self) -> Value:
        value = self.term()
        while True:
            token = self.peek()
            if token is not None and token.text in ("+", "-"):
                op = self.take().text
                right = self.term()
                value = _as_number(value) + _as_number(right) if op == "+" else _as_number(value) - _as_number(right)
            else:
                return value

    def term(self) -> Value:
        value = self.factor()
        while True:
            token = self.peek()
            if token is not None and token.text in ("*", "/"):
                op = self.take().text
                right = _as_number(self.factor())
                if op == "/":
                    if right == 0:
                        raise Undetermined("division by zero")
                    value = _as_number(value) / right
                else:
                    value = _as_number(value) * right
            else:
                return value

    def factor(self) -> Value:
        token = self.peek()
        if token is None:
            raise Undetermined("unexpected end")
        if token.text == "-":
            self.take()
            return -_as_number(self.factor())
        if token.text == "+":
            self.take()
            return self.factor()
        if token.text == "(":
            self.take()
            value = self.comparison()
            self.expect(")")
            return value
        token = self.take()
        if token.kind == "number":
            return float(token.text)
        if token.kind == "string":
            return token.text[1:-1].replace('""', '"')
        if token.kind == "ref":
            return self.resolve(token.text)
        if token.kind == "func":
            return self.call(token.text.upper())
        raise Undetermined("unexpected token %r" % token.text)

    def call(self, name: str) -> Value:
        self.expect("(")
        args: List[Value] = []
        if self.peek() is not None and self.peek().text == ")":
            self.take()
        else:
            while True:
                args.append(self.comparison())
                token = self.peek()
                if token is not None and token.text == ",":
                    self.take()
                    continue
                self.expect(")")
                break
        if name == "AND":
            return all(_as_bool(a) for a in args)
        if name == "OR":
            return any(_as_bool(a) for a in args)
        if name == "NOT":
            return not _as_bool(args[0])
        if name == "ABS":
            return abs(_as_number(args[0]))
        if name in ("ISBLANK",):
            return args[0] is None or args[0] == ""
        if name in ("ISNUMBER",):
            return isinstance(args[0], (int, float)) and not isinstance(args[0], bool)
        raise Undetermined("unsupported function %s" % name)


def _as_number(value: Value) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        raise Undetermined("not numeric: %r" % (value,))


def _as_text(value: Value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _as_bool(value: Value) -> bool:
    if isinstance(value, bool):
        return value
    if value is None or value == "":
        return False
    if isinstance(value, (int, float)):
        return value != 0
    raise Undetermined("not boolean: %r" % (value,))


def _compare(op: str, left: Value, right: Value) -> bool:
    numeric = (isinstance(left, (int, float)) or left is None) and (
        isinstance(right, (int, float)) or right is None
    )
    if numeric:
        lhs, rhs = _as_number(left), _as_number(right)
    elif isinstance(left, str) or isinstance(right, str):
        if op in ("=", "<>"):
            lhs, rhs = _as_text(left).casefold(), _as_text(right).casefold()
        else:
            lhs, rhs = _as_text(left).casefold(), _as_text(right).casefold()
    else:
        raise Undetermined("incomparable")
    if op == "=":
        return lhs == rhs
    if op == "<>":
        return lhs != rhs
    if op == "<":
        return lhs < rhs
    if op == "<=":
        return lhs <= rhs
    if op == ">":
        return lhs > rhs
    return lhs >= rhs


# --------------------------------------------------------------------------


def expand_sqref(sqref: str) -> List[Tuple[int, int]]:
    """'B4:D6 F1' -> [(row, col), ...]"""
    cells: List[Tuple[int, int]] = []
    for part in (sqref or "").split():
        if ":" in part:
            start, end = part.split(":", 1)
            r0, c0 = xm.split_ref(start)
            r1, c1 = xm.split_ref(end)
            for r in range(min(r0, r1), max(r0, r1) + 1):
                for c in range(min(c0, c1), max(c0, c1) + 1):
                    cells.append((r, c))
        elif part:
            cells.append(xm.split_ref(part))
    return cells


def sqref_anchor(sqref: str) -> Tuple[int, int]:
    cells = expand_sqref(sqref)
    if not cells:
        raise Undetermined("empty sqref")
    return min(cells)


_REF_PART = re.compile(r"^(\$?)([A-Z]{1,3})(\$?)(\d+)$")


def translate_ref(ref: str, anchor: Tuple[int, int], target: Tuple[int, int]) -> str:
    """Shift a relative reference from the sqref anchor to a target cell."""
    match = _REF_PART.match(ref)
    if not match:
        raise Undetermined("bad ref %r" % ref)
    col_abs, letters, row_abs, digits = match.groups()
    col = xm.col_letters_to_index(letters)
    row = int(digits)
    if not col_abs:
        col += target[1] - anchor[1]
    if not row_abs:
        row += target[0] - anchor[0]
    if col < 1 or row < 1:
        raise Undetermined("ref out of range")
    return "%s%d" % (xm.col_index_to_letters(col), row)


def make_resolver(workbook: xm.Workbook, sheet: xm.Sheet, anchor, target):
    def resolve(ref: str) -> Value:
        actual = translate_ref(ref, anchor, target)
        cell = sheet.cells.get(actual)
        if cell is None or cell.raw_value is None:
            return None
        if xm.cell_is_numeric(cell):
            return float(cell.raw_value)
        text = xm.cell_text(workbook, cell)
        return text

    return resolve


@dataclass
class RuleOutcome:
    sqref: str
    rule_type: Optional[str]
    dxf_id: Optional[int]
    priority: Optional[int]
    formula: Optional[str]
    fires: List[str]          # cell refs where the predicate is TRUE
    quiet: List[str]          # cell refs where it is FALSE
    undetermined: List[str]   # cell refs where we could not decide
    reason: Optional[str] = None


def evaluate_rule(workbook: xm.Workbook, sheet: xm.Sheet, rule: xm.CfRule, *, max_cells: int = 4000) -> RuleOutcome:
    outcome = RuleOutcome(
        sqref=rule.sqref,
        rule_type=rule.rule_type,
        dxf_id=rule.dxf_id,
        priority=rule.priority,
        formula=rule.formulas[0] if rule.formulas else None,
        fires=[], quiet=[], undetermined=[],
    )
    try:
        cells = expand_sqref(rule.sqref)
        anchor = min(cells) if cells else None
    except Exception as exc:
        outcome.reason = "unparseable sqref: %r" % (exc,)
        return outcome
    if anchor is None:
        outcome.reason = "empty sqref"
        return outcome
    if len(cells) > max_cells:
        outcome.reason = "sqref too large to evaluate (%d cells)" % len(cells)
        outcome.undetermined = ["%s%d" % (xm.col_index_to_letters(c), r) for r, c in cells[:20]]
        return outcome

    for row, col in cells:
        ref = "%s%d" % (xm.col_index_to_letters(col), row)
        try:
            verdict = _evaluate_for_cell(workbook, sheet, rule, anchor, (row, col))
        except Undetermined as exc:
            outcome.undetermined.append(ref)
            if outcome.reason is None:
                outcome.reason = str(exc)
            continue
        except Exception as exc:  # noqa: BLE001 - report, never swallow into "false"
            outcome.undetermined.append(ref)
            if outcome.reason is None:
                outcome.reason = repr(exc)
            continue
        (outcome.fires if verdict else outcome.quiet).append(ref)
    return outcome


def _evaluate_for_cell(workbook, sheet, rule: xm.CfRule, anchor, target) -> bool:
    resolve = make_resolver(workbook, sheet, anchor, target)
    if rule.rule_type == "expression":
        if not rule.formulas:
            raise Undetermined("expression rule with no formula")
        return _as_bool(_Parser(tokenise(rule.formulas[0]), resolve).parse())
    if rule.rule_type == "cellIs":
        ref = "%s%d" % (xm.col_index_to_letters(target[1]), target[0])
        cell = sheet.cells.get(ref)
        if cell is None or cell.raw_value is None:
            left: Value = None
        elif xm.cell_is_numeric(cell):
            left = float(cell.raw_value)
        else:
            left = xm.cell_text(workbook, cell)
        operands = [_Parser(tokenise(f), resolve).parse() for f in rule.formulas]
        op = rule.operator
        if op == "between" and len(operands) == 2:
            return _compare(">=", left, operands[0]) and _compare("<=", left, operands[1])
        if op == "notBetween" and len(operands) == 2:
            return not (_compare(">=", left, operands[0]) and _compare("<=", left, operands[1]))
        mapping = {
            "equal": "=", "notEqual": "<>", "lessThan": "<", "lessThanOrEqual": "<=",
            "greaterThan": ">", "greaterThanOrEqual": ">=",
        }
        if op in mapping and operands:
            return _compare(mapping[op], left, operands[0])
        raise Undetermined("unsupported cellIs operator %r" % op)
    if rule.rule_type in ("containsText", "notContainsText") and rule.text is not None:
        ref = "%s%d" % (xm.col_index_to_letters(target[1]), target[0])
        cell = sheet.cells.get(ref)
        haystack = (xm.cell_text(workbook, cell) or "") if cell else ""
        contains = rule.text.casefold() in haystack.casefold()
        return contains if rule.rule_type == "containsText" else not contains
    raise Undetermined("unsupported rule type %r" % rule.rule_type)
