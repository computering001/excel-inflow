#!/usr/bin/env python3
"""Controller-level regressions for ownership Preflights A and B."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def write_json(target: Path, value: Any) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", "utf-8")


def run_checked(command: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout,
    )
    require(
        completed.returncode == 0,
        f"Command failed ({completed.returncode}): {' '.join(command)}\n"
        f"{completed.stdout}\n{completed.stderr}",
    )
    return completed


def filings_bundle(run_id: str) -> dict[str, Any]:
    filings = {
        "entity_name": "Neutral Working Capital Test Co",
        "historical_periods": ["2023-12-31", "2024-12-31", "2025-12-31"],
        "forecast_periods": ["2026-12-31", "2027-12-31", "2028-12-31"],
        "reporting_currency": "USD",
        "units": "millions",
        "income_statement": [
            {
                "source_line_id": "is.revenue",
                "label": "Revenue",
                "row_type": "input",
                "material": True,
                "values": [900, 950, 1000],
            }
        ],
        "cash_flow": [
            {
                "source_line_id": "cf.change_in_working_capital",
                "label": "Change in working capital",
                "row_type": "subtotal",
                "material": True,
                "values": [-12, -14, -15],
            },
            {
                "source_line_id": "cf.receivables_movement",
                "label": "Receivables movement",
                "row_type": "input",
                "parent_label": "Change in working capital",
                "material": True,
                "values": [-4, -5, -6],
            },
            {
                "source_line_id": "cf.inventory_movement",
                "label": "Inventory movement",
                "row_type": "input",
                "parent_label": "Change in working capital",
                "material": True,
                "values": [-3, -4, -4],
            },
            {
                "source_line_id": "cf.payables_movement",
                "label": "Payables movement",
                "row_type": "input",
                "parent_label": "Change in working capital",
                "material": True,
                "values": [-5, -5, -5],
            },
        ],
    }
    return {
        "schema_version": "filings-evidence-bundle/1.0",
        "run_id": run_id,
        "filings": filings,
    }


def attachment_scenario(mode: str) -> None:
    import run_attachment_evidence_pipeline as pipeline

    with tempfile.TemporaryDirectory(prefix=f"prebroker-{mode}-") as temporary:
        root = Path(temporary)
        output = root / "out"
        spec_path = root / "spec.json"
        choice_path = root / "choice.json"
        write_json(choice_path, {"scenario": mode})
        spec = {
            "schema_version": "attachment-evidence-controller/1.0",
            "run_id": f"prebroker_{mode}",
            "attachment_ingress_path": "unused-ingress.json",
            "case_source_declarations_path": "unused-declarations.json",
            "broker_intake_choice_path": str(choice_path),
            "filings": {"request_path": "unused-filings.json"},
            "broker": {"request_path": "unused-broker.json"},
            "dcs": {"request_path": "unused-dcs.json"},
        }
        write_json(spec_path, spec)
        order: list[str] = []

        pipeline.runtime_closure = lambda: "f" * 64
        pipeline.verify_broker_intake_choice = lambda _spec, _path: (
            {
                "intake_state": "supplied",
                "receipt_sha256": "a" * 64,
                "runtime_closure_sha256": "f" * 64,
            },
            choice_path,
        )

        def fake_run_lane(
            kind: str,
            _declaration: dict[str, Any],
            _base: Path,
            output_root: Path,
        ) -> dict[str, Any]:
            order.append(kind)
            if kind == "filings":
                bundle_path = output_root / "filings" / "filings-evidence-bundle.json"
                state_path = output_root / "filings" / "filings-run-state.json"
                write_json(bundle_path, filings_bundle(spec["run_id"]))
                state = {
                    "schema_version": "filings-run-state/1.0",
                    "pipeline_status": "PASS",
                    "user_blocking": False,
                    "blocker_class": None,
                    "tasks": [],
                    "artifacts": {"filings_bundle": str(bundle_path)},
                    "artifact_sha256": {},
                    "summary": {},
                }
                write_json(state_path, state)
                return state
            receipt_path = output_root / "ownership" / "structural-ownership-preflight.json"
            require(receipt_path.is_file(), f"{kind} launched before Preflight A was persisted")
            receipt = json.loads(receipt_path.read_text("utf-8"))
            require(
                receipt.get("checkpoint") == "A_STRUCTURAL"
                and receipt.get("status") == "PASS"
                and (receipt.get("controller_signal") or {}).get("action") == "continue",
                f"{kind} launched without a passing Preflight A receipt",
            )
            family = next(
                (
                    item for item in receipt.get("families") or []
                    if item.get("parent_row_id") == "cf.change_in_working_capital"
                ),
                None,
            )
            require(
                family is not None
                and family.get("broker_demand_owner_row_ids")
                == ["cf.change_in_working_capital"]
                and len(family.get("child_row_ids") or []) == 3,
                f"{kind} launched after a non-structural or demand-blind A receipt",
            )
            return {
                "schema_version": f"{kind}-run-state/1.0",
                "pipeline_status": "BLOCKED_INPUT",
                "user_blocking": True,
                "blocker_class": "FATAL_SOURCE",
                "tasks": [],
                "artifacts": {},
                "artifact_sha256": {},
                "summary": {"terminal_reason": "test_stop_after_descendant_launch"},
            }

        pipeline.run_lane = fake_run_lane
        original_preflight = pipeline.run_structural_ownership_preflight

        def observed_preflight(**kwargs: Any) -> tuple[dict[str, Any], Path, int]:
            result = original_preflight(**kwargs)
            order.append("A_STRUCTURAL")
            return result

        pipeline.run_structural_ownership_preflight = observed_preflight
        if mode == "tamper":
            original_run = pipeline.run

            def tampering_run(
                command: list[str], *, timeout_seconds: int | None = None
            ) -> subprocess.CompletedProcess[str]:
                if "run_structural_ownership_preflight.mjs" in " ".join(command) and "--verify" in command:
                    receipt_path = Path(command[command.index("--verify") + 1])
                    receipt = json.loads(receipt_path.read_text("utf-8"))
                    receipt["topology_input_sha256"] = "0" * 64
                    write_json(receipt_path, receipt)
                return original_run(command, timeout_seconds=timeout_seconds)

            pipeline.run = tampering_run

        prior_argv = sys.argv
        try:
            sys.argv = [str(HERE / "run_attachment_evidence_pipeline.py"), str(spec_path), "--out", str(output)]
            result = pipeline.main()
        finally:
            sys.argv = prior_argv

        state = json.loads((output / "attachment-evidence-run-state.json").read_text("utf-8"))
        if mode == "valid":
            require(result == 2, "Valid ordering scenario did not reach the controlled descendant stop")
            require(order[0] == "filings", "Filings was not the first evidence lane")
            require("A_STRUCTURAL" in order, "Preflight A did not execute")
            a_index = order.index("A_STRUCTURAL")
            require(
                all(order.index(kind) > a_index for kind in ("broker", "dcs")),
                f"A descendant launched before Preflight A: {order}",
            )
        else:
            require(result == 2, "Tampered Preflight A did not stop the controller")
            require(order == ["filings"], f"Tampered A launched descendants: {order}")
            require(
                state.get("pipeline_status") == "BLOCKED_INTERNAL"
                and state.get("user_blocking") is False,
                "Tampered A was not classified as internal controller work",
            )
            require(
                (state.get("summary") or {}).get("descendant_lanes_started") == []
                and ((state.get("summary") or {}).get("controller_signal") or {}).get("action")
                == "cancel_descendants_preserve_checkpoint",
                "Tampered A did not preserve the early-cancellation contract",
            )


def neutral_working_capital_controller() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="wc-neutral-controller-") as temporary:
        root = Path(temporary)
        evidence = root / "evidence.json"
        run_root = root / "run"
        run_checked([
            "node",
            str(HERE / "run_evidence_run_tests.mjs"),
            "test-fixtures/cases",
            "--emit-fixture",
            "working-capital-neutral",
            str(evidence),
        ])
        relevant_evidence_at = time.monotonic()
        run_checked([
            "node",
            str(HERE / "run_user_flow.mjs"),
            str(evidence),
            "--out",
            str(run_root),
            "--stop-after",
            "decisions",
            "--json",
        ])
        elapsed_ms = round((time.monotonic() - relevant_evidence_at) * 1000)
        result = json.loads((run_root / "user-flow-result.json").read_text("utf-8"))
        validation = json.loads(
            (run_root / "stages" / "inputs" / "evidence-validation.json").read_text("utf-8")
        )
        model = ((validation.get("handoff") or {}).get("model_case") or {})
        require(elapsed_ms < 120_000, f"Ownership resolution took {elapsed_ms}ms")
        require(
            result.get("status") == "PAUSED"
            and result.get("stage") == "decisions"
            and result.get("user_blocking") is False,
            "Neutral working-capital evidence did not auto-progress without user action",
        )
        selected = (model.get("forecast_ownership_preflights") or {}).get("selected") or {}
        wc_resolutions = [
            item for item in selected.get("resolutions") or []
            if item.get("parent_row_id") == "change_in_working_capital"
        ]
        require(
            selected.get("status") == "PASS"
            and len(wc_resolutions) == 3
            and all(item.get("selected_mode") == "parent_owned" for item in wc_resolutions),
            "Checkpoint B did not detect and auto-resolve aggregate working-capital ownership",
        )
        rows = {
            row.get("row_id"): row
            for row in (model.get("statement_structure") or {}).get("cash_flow") or []
        }
        parent = rows.get("change_in_working_capital") or {}
        require(
            all(
                authority.get("method") == "broker_consensus"
                for authority in parent.get("forecast_period_authorities") or []
            ),
            "Aggregate broker authority was not retained",
        )
        child_ids = {"receivables_movement", "inventory_movement", "payables_movement"}
        require(
            all(
                rows.get(row_id, {}).get("forecast_capture_parent_id") == "change_in_working_capital"
                and all(
                    authority.get("method") == "not_separately_forecast"
                    for authority in rows.get(row_id, {}).get("forecast_period_authorities") or []
                )
                for row_id in child_ids
            ),
            "Child fallback/user forecasts were not captured exactly once",
        )
        rejected = [
            item for item in selected.get("rejected_authorities") or []
            if item.get("row_id") in child_ids
        ]
        rejected_methods = {item.get("authority", {}).get("method") for item in rejected}
        require(
            {"historical_trend", "user_assumption"}.issubset(rejected_methods)
            and len(rejected) == 9,
            "Checkpoint B did not retain all rejected fallback/user evidence",
        )
        return {
            "elapsed_ms_from_relevant_evidence": elapsed_ms,
            "resolution_count": len(wc_resolutions),
            "rejected_evidence_count": len(rejected),
            "user_action_required": False,
        }


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--attachment-scenario":
        attachment_scenario(sys.argv[2])
        print(json.dumps({"scenario": sys.argv[2], "status": "PASS"}, sort_keys=True))
        return 0
    for scenario in ("valid", "tamper"):
        run_checked([sys.executable, str(Path(__file__).resolve()), "--attachment-scenario", scenario])
    neutral = neutral_working_capital_controller()
    print(json.dumps({
        "status": "PASS",
        "checks": {
            "preflight_a_call_order": "PASS",
            "tampered_preflight_a_early_cancel": "PASS",
            "neutral_working_capital_controller": neutral,
        },
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
