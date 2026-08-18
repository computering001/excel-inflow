#!/usr/bin/env python3
"""Independent broker Model Consensus membership oracle.

This module is intentionally standard-library only and does not import the
case compiler, forecast compiler, row plan, solver or workbook emitter.  It
recomputes membership from the sealed model-case contract and detects stale,
incompatible, rejected and period-ineligible contributors before their values
can be presented as a market average.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


DIMENSIONS = (
    "metric_id",
    "accounting_basis",
    "operation_scope",
    "adjustment_basis",
    "currency",
    "units",
    "fiscal_calendar",
    "cash_flow_basis",
    "lease_basis",
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def finite(value: Any) -> bool:
    return (
        value is not None
        and not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(float(value))
    )


def target_signature(model_case: dict, metric_id: str, metric: dict) -> dict:
    issuer = model_case.get("issuer") or {}
    declared = metric.get("definition_signature") or {}
    return {
        "metric_id": declared.get("metric_id", metric_id),
        "accounting_basis": declared.get("accounting_basis", issuer.get("accounting_basis")),
        "operation_scope": declared.get("operation_scope", "continuing"),
        "adjustment_basis": declared.get(
            "adjustment_basis",
            "adjusted" if metric_id.startswith("adjusted_") else "statutory",
        ),
        "currency": declared.get("currency", issuer.get("reporting_currency")),
        "units": declared.get("units", issuer.get("units")),
        "fiscal_calendar": declared.get("fiscal_calendar", issuer.get("fiscal_calendar", "fixed_date")),
        "cash_flow_basis": declared.get("cash_flow_basis"),
        "lease_basis": declared.get("lease_basis"),
    }


def incompatible_dimensions(left: dict, right: dict) -> list[str]:
    mismatches = []
    for dimension in DIMENSIONS:
        a, b = left.get(dimension), right.get(dimension)
        if a is not None and b is not None and a != b:
            mismatches.append(dimension)
    return mismatches


def inspect_metric(model_case: dict, metric_id: str, metric: dict) -> tuple[dict, list[dict]]:
    findings: list[dict] = []
    membership = metric.get("consensus_membership")
    if not isinstance(membership, dict):
        return {}, [{
            "code": "CONSENSUS_MEMBERSHIP_ABSENT",
            "metric_id": metric_id,
            "message": "Model Consensus has no sealed contributor membership.",
        }]
    body = {key: value for key, value in membership.items() if key != "membership_sha256"}
    if membership.get("schema_version") != "broker-consensus-membership/1.0":
        findings.append({"code": "CONSENSUS_MEMBERSHIP_VERSION", "metric_id": metric_id})
    if membership.get("membership_sha256") != digest(body):
        findings.append({"code": "CONSENSUS_MEMBERSHIP_HASH", "metric_id": metric_id})
    if membership.get("metric_id") != metric_id:
        findings.append({"code": "CONSENSUS_MEMBERSHIP_METRIC", "metric_id": metric_id})

    contributors = membership.get("contributors") or []
    names = [str(entry.get("house_name")) for entry in contributors]
    expected_names = sorted((metric.get("brokers") or {}).keys())
    if names != expected_names or len(names) != len(set(names)):
        findings.append({"code": "CONSENSUS_MEMBERSHIP_COVERAGE", "metric_id": metric_id})

    target = target_signature(model_case, metric_id, metric)
    periods = []
    for period_index in range(3):
        included, excluded = [], []
        for entry in contributors:
            house_name = entry.get("house_name")
            reasons = list(entry.get("reasons") or []) if entry.get("status") != "included" else []
            reasons.extend(
                "incompatible %s" % dimension
                for dimension in incompatible_dimensions(entry.get("definition_signature") or {}, target)
            )
            period_status = (entry.get("period_status") or [None, None, None])[period_index]
            if period_status != "included":
                reasons.extend((entry.get("period_reasons") or [[], [], []])[period_index])
                if not reasons:
                    reasons.append("period status %s" % period_status)
            if reasons:
                excluded.append({"house_name": house_name, "reasons": sorted(set(reasons))})
                continue
            series = (metric.get("brokers") or {}).get(house_name) or []
            value = series[period_index] if period_index < len(series) else None
            if finite(value):
                included.append({"house_name": house_name, "value": float(value)})
        values = [entry["value"] for entry in included]
        periods.append({
            "period_index": period_index,
            "included_houses": [entry["house_name"] for entry in included],
            "excluded_houses": excluded,
            "contributor_count": len(included),
            "excluded_count": len(excluded),
            "model_consensus": sum(values) / len(values) if values else None,
        })
    return {"metric_id": metric_id, "periods": periods}, findings


def inspect_model_case(model_case: dict) -> dict:
    findings: list[dict] = []
    metrics = []
    for metric_id, metric in sorted(((model_case.get("broker_pack") or {}).get("metrics") or {}).items()):
        if not (metric.get("brokers") or {}):
            continue
        result, metric_findings = inspect_metric(model_case, metric_id, metric)
        metrics.append(result)
        findings.extend(metric_findings)
    return {
        "schema_version": "broker-consensus-membership-oracle-report/1.0",
        "status": "PASS" if not findings else "BLOCK",
        "metrics": metrics,
        "findings": findings,
        "total_violations": len(findings),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_case")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    model_case = json.loads(Path(args.model_case).read_text(encoding="utf-8"))
    report = inspect_model_case(model_case)
    Path(args.out).write_text(canonical_json(report) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": report["status"],
        "total_violations": report["total_violations"],
        "output": str(Path(args.out).resolve()),
    }, sort_keys=True))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
