#!/usr/bin/env python3
"""Locale-safe broker numeric parsing shared by every authority layer."""

from __future__ import annotations

import math
import re
from typing import Any


_WRAPPER = re.compile(
    r"^\s*(?P<open>\()?\s*(?P<sign>[-+]?)\s*[$€£¥]?\s*"
    r"(?P<number>\d[\d., ]*)\s*(?P<suffix>%|[xX])?\s*(?P<close>\))?\s*$"
)


def _decimal_body(raw: str) -> str | None:
    compact = raw.replace(" ", "")
    if not compact or not re.fullmatch(r"\d[\d.,]*", compact):
        return None
    comma = compact.rfind(",")
    dot = compact.rfind(".")
    if comma >= 0 and dot >= 0:
        decimal = "," if comma > dot else "."
    elif comma >= 0:
        groups = compact.split(",")
        decimal = None if all(len(item) == 3 for item in groups[1:]) else ","
    elif dot >= 0:
        groups = compact.split(".")
        decimal = None if all(len(item) == 3 for item in groups[1:]) else "."
    else:
        decimal = None
    if decimal is None:
        return compact.replace(",", "").replace(".", "")
    integer, fraction = compact.rsplit(decimal, 1)
    if not fraction:
        return None
    integer = integer.replace(",", "").replace(".", "")
    return f"{integer}.{fraction}"


def parse_broker_number(value: Any, *, scale_percent: bool = True) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    match = _WRAPPER.fullmatch(str(value))
    if not match or bool(match.group("open")) != bool(match.group("close")):
        return None
    body = _decimal_body(match.group("number"))
    if body is None:
        return None
    try:
        number = float(body)
    except ValueError:
        return None
    if match.group("sign") == "-" or match.group("open"):
        number = -abs(number)
    if scale_percent and match.group("suffix") == "%":
        number /= 100.0
    return number if math.isfinite(number) else None


def canonical_numeric_token(value: Any) -> str | None:
    number = parse_broker_number(value, scale_percent=False)
    if number is None:
        return None
    raw = str(value).strip()
    suffix = "%" if "%" in raw else ("x" if raw.casefold().endswith("x") else "")
    body = str(int(number)) if number.is_integer() else format(number, ".15g")
    return body + suffix
