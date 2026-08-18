#!/usr/bin/env python3
"""Positive and field-deletion mutation proof for canonical zero authority."""

from __future__ import annotations

import json
from copy import deepcopy
import tempfile
from pathlib import Path

import run_attachment_evidence_pipeline as attachment
from zero_broker_authority import (
    apply_zero_broker_authority,
    build_zero_broker_pack,
    validate_zero_broker_pack,
)


def evidence() -> dict:
    return {
        "filings": {
            "historical_periods": ["2023-12-31", "2024-12-31", "2025-12-31"],
            "forecast_periods": ["2026-12-31", "2027-12-31", "2028-12-31"],
            "reporting_currency": "USD",
            "units": "millions",
        },
        "case_evidence": {"lanes": {"controls": {"broker_case": "Stale House"}}},
        "broker_pack": {
            "schema_version": "broker-pack/1.0",
            "pack_kind": "broker_forecast_set",
            "as_of": "2025-12-31",
            "reporting_currency": "USD",
            "units": "millions",
            "forecast_periods": ["2026-12-31", "2027-12-31", "2028-12-31"],
            "metrics": {"revenue": {"unit_kind": "currency"}},
            "houses": [{"house_id": "stale"}],
        },
    }


def main() -> int:
    checks = 0
    skipped = build_zero_broker_pack(
        evidence(), source_label="Broker research explicitly skipped", notes="skip"
    )
    failed = build_zero_broker_pack(
        evidence(), source_label="Forecast Waterfall — zero broker authority", notes="fault"
    )
    validate_zero_broker_pack(skipped)
    validate_zero_broker_pack(failed)
    checks += 2

    economic_fields = (
        "schema_version",
        "pack_kind",
        "as_of",
        "reporting_currency",
        "units",
        "forecast_periods",
        "metrics",
        "houses",
        "recommended_primary_house_id",
        "eligibility_summary",
    )
    assert {key: skipped.get(key) for key in economic_fields} == {
        key: failed.get(key) for key in economic_fields
    }
    checks += 1

    required = (
        "schema_version",
        "pack_kind",
        "as_of",
        "reporting_currency",
        "units",
        "forecast_periods",
        "metrics",
        "houses",
    )
    killed = []
    for field in required:
        mutation = deepcopy(failed)
        del mutation[field]
        try:
            validate_zero_broker_pack(mutation)
        except ValueError:
            killed.append(f"delete_{field}")
            checks += 1
        else:
            raise AssertionError(f"deleting required zero-pack field {field} survived")

    leak = deepcopy(failed)
    leak["metrics"] = {"revenue": {}}
    try:
        validate_zero_broker_pack(leak)
    except ValueError:
        killed.append("broker_value_survives_zero_projection")
        checks += 1
    else:
        raise AssertionError("broker metric survived zero authority")

    target = evidence()
    target["forecast_observation_ledger"] = {
        "observations": [{"source_kind": "broker", "value": 999}]
    }
    apply_zero_broker_authority(target, source_label="zero", notes="test")
    lane = target["case_evidence"]["lanes"]["broker_pack"]
    assert target["broker_pack"]["houses"] == []
    assert lane["metrics"] == {} and lane["source_mappings"] == []
    assert target["case_evidence"]["lanes"]["controls"]["broker_case"] == "Forecast Waterfall"
    checks += 3

    with tempfile.TemporaryDirectory(prefix="excel-inflow-archive-only-zero-") as temporary:
        root = Path(temporary)
        raw = root / "house-a.pdf"
        raw.write_bytes(b"%PDF-1.4\narchive-only test evidence\n")
        template = evidence()
        template["source_inventory"] = [{
            "source_id": "house-a-source",
            "kind": "user_broker_research",
            "name": "House A",
            "status": "used",
            "publication_date": "2026-08-15",
        }]
        template["retrieval_log"] = [{"selected_source_id": "house-a-source"}]
        evidence_path = root / "evidence.json"
        evidence_path.write_text(json.dumps(template), "utf-8")
        resolved = {
            "evidence_run_path": str(evidence_path),
            "broker_evidence": {"run_state_path": "stale"},
            "attachments": [{
                "attachment_id": "house-a",
                "path": str(raw),
                "media_type": "application/pdf",
                "source_ids": ["house-a-source"],
                "adapter": {"domain": "broker_pack"},
            }],
        }
        updated, artifacts = attachment.apply_broker_archive_only(
            resolved_ingress=resolved,
            ingress_base=root,
            output_root=root / "run",
        )
        archived = json.loads(Path(
            artifacts["broker_archive_only_evidence"]
        ).read_text("utf-8"))
        validate_zero_broker_pack(archived["broker_pack"])
        archive = archived["case_evidence"]["lanes"]["broker_archive"]
        assert archive["raw_documents"][0]["content_sha256"] == attachment.sha256_file(raw)
        assert archived["source_inventory"][0]["status"] == "evidence_only"
        assert "broker_evidence" not in updated
        checks += 4

    print(json.dumps({
        "schema_version": "zero-broker-authority-test-report/1.0",
        "status": "PASS",
        "checks": checks,
        "killed_mutations": killed,
        "explicit_skip_failure_economic_parity": True,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
