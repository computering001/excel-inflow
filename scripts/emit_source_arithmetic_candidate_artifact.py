#!/usr/bin/env python3
"""Emit a production source-arithmetic artifact for an independent oracle."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from extract_filing_statements import infer_source_arithmetic_links


def row(identifier, values, *, currency="GBP", units="millions"):
    return {
        "source_line_id": identifier,
        "label": identifier,
        "values": values,
        "hierarchy_level": 1,
        "numeric_type": "currency",
        "reporting_currency": currency,
        "units": units,
        "sign_convention": "cash_flow_signed",
        "value_states": ["reported_number"] * 3,
        "value_precisions": [0, 0, 0],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    rows = [
        row("compatible_a", [40, 42, 44]),
        row("compatible_b", [60, 63, 66]),
        {**row("compatible_total", [100, 105, 110]), "hierarchy_level": 0},
        row("incompatible_gbp", [25, 26, 27]),
        row("incompatible_usd", [75, 79, 83], currency="USD"),
        {**row("incompatible_total", [100, 105, 110]), "hierarchy_level": 0},
    ]
    infer_source_arithmetic_links(rows)
    artifact = {
        "schema_version": "source-arithmetic-candidate-artifact/1.0",
        "producer": "extract_filing_statements.infer_source_arithmetic_links",
        "rows": rows,
    }
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "output": str(target.resolve())}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
