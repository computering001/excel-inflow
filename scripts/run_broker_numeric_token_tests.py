#!/usr/bin/env python3
"""Non-vacuous tests for broker census numeric-token boundaries."""

from __future__ import annotations

import json

from extract_broker_evidence import numeric_tokens


checks = []


def expect(source, expected, message):
    actual = numeric_tokens(source)
    if actual != expected:
        raise AssertionError(f"{message}: {actual!r} != {expected!r}")
    checks.append(message)


expect("Revenue 1000 1,050 (25) 3.5% 12x", ["1000", "1050", "-25", "3.5%", "12x"],
       "ordinary financial values remain census-visible")
expect("2026E 2027A FY2028 1Q29E", [],
       "forecast and actual period headers are not partial numeric values")
expect("abc123 123abc", [],
       "digits embedded in identifiers are not partial numeric values")
expect("2026 2027", ["2026", "2027"],
       "standalone years remain visible when they are actual source numbers")

print(json.dumps({"status": "PASS", "checks": len(checks), "proof": checks}, indent=2))
