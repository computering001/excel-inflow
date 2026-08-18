"""Independent parent/child forecast-ownership walker.

The walker intentionally imports no production forecast-authority, statement-
topology, case-compiler, or row-plan module.  It evaluates only the materialised
row graph and its per-period authority certificates.
"""

from __future__ import annotations


ABSENT_METHODS = {"not_separately_forecast", "not_applicable", "unresolved"}


def _method(row: dict, forecast_index: int) -> str:
    authorities = row.get("forecast_period_authorities") or []
    if forecast_index < len(authorities):
        method = authorities[forecast_index].get("method")
        if isinstance(method, str) and method:
            return method
    if row.get("forecast_capture_parent_id"):
        return "not_separately_forecast"
    calculation = row.get("calculation") or {}
    if calculation.get("operator") == "sum":
        return "accounting_identity"
    return "unresolved"


def walk_forecast_ownership(model_case: dict) -> dict:
    findings = []
    checked_aggregates = 0
    checked_periods = 0

    def block(code: str, message: str, **details) -> None:
        findings.append({"severity": "BLOCK", "code": code, "message": message, **details})

    statements = model_case.get("statement_structure") or {}
    for section in ("income_statement", "cash_flow"):
        rows = statements.get(section) or []
        by_id = {
            row.get("row_id"): row
            for row in rows
            if isinstance(row, dict) and isinstance(row.get("row_id"), str)
        }
        children_by_parent = {}
        for row in rows:
            parent_id = row.get("parent_row_id")
            if parent_id:
                if parent_id not in by_id:
                    block(
                        "INDEPENDENT_FORECAST_ORPHAN_CHILD",
                        "A forecast child names an absent parent.",
                        section=section,
                        row_id=row.get("row_id"),
                        parent_row_id=parent_id,
                    )
                    continue
                children_by_parent.setdefault(parent_id, {})[row["row_id"]] = row

        for parent in rows:
            parent_id = parent.get("row_id")
            children = dict(children_by_parent.get(parent_id, {}))
            calculation = parent.get("calculation") or {}
            if calculation.get("operator") == "sum":
                for child_id in calculation.get("refs") or []:
                    if child_id in by_id and child_id != parent_id:
                        children[child_id] = by_id[child_id]
            child_rows = list(children.values())
            source_visible = (
                parent.get("historical_authority") == "reported_total_reconciled"
                and bool(parent.get("source_line_ids"))
                and child_rows
                and all(
                    child.get("historical_authority")
                    in {"source_input", "reported_total_reconciled"}
                    and bool(child.get("source_line_ids"))
                    for child in child_rows
                )
            )
            is_aggregate = len(child_rows) >= 2 and (
                parent.get("aggregation_authority")
                in {"reported_parent", "derived_from_children"}
                or source_visible
            )
            if not is_aggregate:
                continue
            checked_aggregates += 1
            for forecast_index in range(3):
                checked_periods += 1
                parent_method = _method(parent, forecast_index)
                child_methods = {
                    child["row_id"]: _method(child, forecast_index)
                    for child in child_rows
                }
                parent_independent = (
                    parent_method not in ABSENT_METHODS
                    and parent_method not in {"accounting_identity", "schedule_link"}
                )
                if parent_independent:
                    live_children = {
                        row_id: method
                        for row_id, method in child_methods.items()
                        if method not in ABSENT_METHODS
                    }
                    if live_children:
                        block(
                            "INDEPENDENT_PARENT_CHILD_DOUBLE_FORECAST",
                            "An independently forecast parent coexists with live forecast children.",
                            section=section,
                            parent_row_id=parent_id,
                            forecast_index=forecast_index,
                            parent_method=parent_method,
                            live_children=live_children,
                        )
                elif parent_method == "accounting_identity":
                    missing_children = {
                        row_id: method
                        for row_id, method in child_methods.items()
                        if method in ABSENT_METHODS
                    }
                    if missing_children:
                        block(
                            "INDEPENDENT_CHILDREN_OWNERSHIP_INCOMPLETE",
                            "A children-owned aggregate has absent forecast members.",
                            section=section,
                            parent_row_id=parent_id,
                            forecast_index=forecast_index,
                            missing_children=missing_children,
                        )

    if checked_aggregates == 0:
        block(
            "INDEPENDENT_FORECAST_OWNERSHIP_VACUOUS",
            "No source-visible aggregate was independently walked.",
        )
    return {
        "status": "PASS" if not findings else "BLOCK",
        "total_violations": len(findings),
        "checked_aggregates": checked_aggregates,
        "checked_periods": checked_periods,
        "findings": findings,
    }
