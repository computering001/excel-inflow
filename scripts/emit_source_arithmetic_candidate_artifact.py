#!/usr/bin/env python3
"""Emit a production source-arithmetic artifact for an independent oracle."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from extract_filing_statements import infer_source_arithmetic_links


def row(identifier, values, *, currency="GBP", units="millions", level=1):
    return {
        "source_line_id": identifier,
        "label": identifier,
        "values": values,
        "hierarchy_level": level,
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
    parser.add_argument("--model-case", required=True)
    args = parser.parse_args()
    model_case_path = Path(args.model_case).resolve()
    model_case = json.loads(model_case_path.read_text(encoding="utf-8"))
    rows = []
    for section in ("income_statement", "cash_flow"):
        statement_rows = model_case.get("statement_structure", {}).get(section, [])
        by_id = {item.get("row_id"): item for item in statement_rows}
        for parent in statement_rows:
            refs = (parent.get("calculation") or {}).get("refs") or []
            children = [by_id.get(ref) for ref in refs]
            if len(children) < 2 or any(child is None for child in children):
                continue
            histories = [child.get("values", [])[:3] for child in children]
            if any(len(values) != 3 or any(value is None for value in values) for values in histories):
                continue
            for child, values in zip(children, histories):
                rows.append(row(str(child["row_id"]), [float(value) for value in values]))
            totals = [sum(float(values[index]) for values in histories) for index in range(3)]
            rows.append(row(str(parent["row_id"]), totals, level=0))
            break
        if rows:
            break
    if not rows:
        raise ValueError("Candidate model case has no emitted additive historical family.")
    infer_source_arithmetic_links(rows)
    body = {
        "schema_version": "source-arithmetic-candidate-artifact/1.0",
        "producer": "extract_filing_statements.infer_source_arithmetic_links",
        "source_model_case_sha256": hashlib.sha256(model_case_path.read_bytes()).hexdigest(),
        "rows": rows,
    }
    artifact = {
        **body,
        "artifact_sha256": hashlib.sha256(
            (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode()
        ).hexdigest(),
    }
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "output": str(target.resolve())}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
