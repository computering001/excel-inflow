#!/usr/bin/env python3
"""Independent verifier for one installed-capability artifact generation.

This audit tool intentionally uses the Python standard library only.  It does
not import the runtime doctor, the candidate package, or any product hashing
helper.  The content and identity algorithms below are independently
implemented from the published byte contracts.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from typing import Any


SHA256 = re.compile(r"^[0-9a-f]{64}$")
REPORT_PREFIX = "runtime-doctor-report-"
RECEIPT_PREFIX = "installed-capability-receipt-"
POINTER_NAME = "host-preflight-current.json"
RECEIPT_V12 = "excel-inflow-installed-capability-receipt/1.2"
RECEIPT_V13 = "excel-inflow-installed-capability-receipt/1.3"
DISK_SPACE_POLICY_SCHEMA_NAME = "disk-space-policy-v1.schema.json"
ACTIVATION_MAX_AGE_SECONDS = 3600
ACTIVATION_MAX_FUTURE_SKEW_SECONDS = 300


def canonical_json(value: Any, *, newline: bool) -> bytes:
    """Match the declared canonical-JSON contract without product helpers."""
    text = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return (text + ("\n" if newline else "")).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_regular_file(target: Path, findings: list[str], label: str) -> bytes | None:
    try:
        metadata = target.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            findings.append(f"{label}:not_regular_file:{target}")
            return None
        return target.read_bytes()
    except (OSError, ValueError) as error:
        findings.append(f"{label}:unreadable:{target}:{error}")
        return None


def parse_json_bytes(value: bytes | None, findings: list[str], label: str) -> Any | None:
    if value is None:
        return None
    try:
        return json.loads(value.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        findings.append(f"{label}:invalid_json:{error}")
        return None


def safe_pointer_name(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value.endswith(".json")
        and value not in (".", "..")
        and Path(value).name == value
        and "/" not in value
        and "\\" not in value
    )


def find_check(report: dict[str, Any], precondition_id: str) -> dict[str, Any] | None:
    matches = [
        item for item in report.get("checks", [])
        if isinstance(item, dict) and item.get("precondition_id") == precondition_id
    ]
    return matches[0] if len(matches) == 1 else None


def file_sha256(target: Path, findings: list[str], label: str) -> str | None:
    value = read_regular_file(target, findings, label)
    return sha256_bytes(value) if value is not None else None


def executable_sha256(target: Path, findings: list[str], label: str) -> str | None:
    """Hash selected executable bytes while retaining its selected path identity."""
    try:
        resolved = target.resolve(strict=True)
        if not resolved.is_file():
            findings.append(f"{label}:resolved_target_not_regular:{resolved}")
            return None
        return sha256_bytes(target.read_bytes())
    except OSError as error:
        findings.append(f"{label}:unreadable:{target}:{error}")
        return None


def inventory_identity(package_root: Path, findings: list[str]) -> tuple[dict[str, str], str]:
    files: dict[str, str] = {}
    try:
        directories = [package_root]
        while directories:
            directory = directories.pop()
            for entry in sorted(directory.iterdir(), key=lambda item: item.name):
                metadata = entry.lstat()
                relative = entry.relative_to(package_root).as_posix()
                if stat.S_ISLNK(metadata.st_mode):
                    findings.append(f"package_inventory:symlink_member:{relative}")
                elif stat.S_ISDIR(metadata.st_mode):
                    directories.append(entry)
                elif stat.S_ISREG(metadata.st_mode):
                    files[relative] = sha256_bytes(entry.read_bytes())
                else:
                    findings.append(f"package_inventory:non_regular_member:{relative}")
    except OSError as error:
        findings.append(f"package_inventory:unreadable:{error}")
    ordered = dict(sorted(files.items()))
    return ordered, sha256_bytes(canonical_json(ordered, newline=False))


def expected_product_identity(
    manifest: dict[str, Any],
    inventory_sha256: str,
    archive_sha256: str,
) -> dict[str, Any]:
    identity = manifest["identity"]
    closure = identity["package"]["runtime_code_closure"]
    deployment = identity["deployment"]
    installed = deployment.get("installed_package") or {}
    return {
        "schema_version": "product-identity/2.0",
        "source": {
            "identity_kind": "source_tree",
            "repository": identity["source"].get("repository"),
            "commit_sha": identity["source"].get("commit_sha"),
            "tree_sha": identity["source"].get("tree_sha"),
        },
        "package": {
            "mode": identity["package"].get("mode"),
            "runtime_code_closure": {
                "identity_kind": "runtime_code_closure",
                "sha256": closure.get("sha256"),
                "certified_sha256": closure.get("certified_sha256"),
            },
            "complete_package_inventory": {
                "identity_kind": "complete_package_inventory",
                "sha256": inventory_sha256,
            },
            "archive": {"identity_kind": "archive", "sha256": archive_sha256},
        },
        "deployment": {
            "status": deployment.get("status"),
            "installation_identity": deployment.get("installation_identity"),
            "installed_package": {
                "identity_kind": "installed_package",
                "sha256": installed.get("sha256"),
            },
        },
    }


def equal(finding: str, observed: Any, expected: Any, findings: list[str]) -> None:
    if observed != expected:
        findings.append(f"{finding}:mismatch")


def parse_timestamp(value: Any, finding: str, findings: list[str]) -> dt.datetime | None:
    try:
        if not isinstance(value, str) or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", value):
            raise ValueError("timezone offset is required")
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timestamp has no timezone")
        return parsed.astimezone(dt.timezone.utc)
    except (TypeError, ValueError) as error:
        findings.append(f"{finding}:invalid:{error}")
        return None


def require_sha256(value: Any, finding: str, findings: list[str]) -> None:
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        findings.append(f"{finding}:invalid_sha256")


def require_satisfied_check(
    report: dict[str, Any],
    precondition_id: str,
    findings: list[str],
) -> dict[str, Any] | None:
    check = find_check(report, precondition_id)
    if check is None:
        findings.append(f"report.check:{precondition_id}:missing_or_duplicate")
        return None
    if check.get("result") != "satisfied":
        findings.append(f"report.check:{precondition_id}:not_satisfied")
    if not isinstance(check.get("detail"), dict):
        findings.append(f"report.check:{precondition_id}:detail_missing")
    return check


def verify_runtime_compatibility(
    receipt: dict[str, Any],
    report: dict[str, Any],
    package_root: Path,
    is_v13: bool,
    findings: list[str],
) -> None:
    check = require_satisfied_check(report, "runtime_version_compatibility", findings)
    detail = check.get("detail", {}) if check else {}
    observed = receipt.get("runtime_compatibility")
    equal("receipt.runtime_compatibility.report_join", observed, detail, findings)
    if not isinstance(observed, dict):
        findings.append("receipt.runtime_compatibility:missing")
        return
    equal("receipt.runtime_compatibility.status", observed.get("status"), "PASS", findings)
    equal("receipt.runtime_compatibility.total_violations", observed.get("total_violations"), 0, findings)
    equal("receipt.runtime_compatibility.findings", observed.get("findings"), [], findings)
    if is_v13:
        contract_path = package_root / "assets" / "runtime-compatibility-v1.json"
        contract_bytes = read_regular_file(
            contract_path, findings, "runtime_compatibility_contract"
        )
        contract = parse_json_bytes(contract_bytes, findings, "runtime_compatibility_contract")
        if isinstance(contract, dict):
            equal(
                "receipt.runtime_compatibility.contract_schema_version",
                observed.get("contract_schema_version"),
                contract.get("schema_version"),
                findings,
            )
            equal(
                "receipt.runtime_compatibility.contract_sha256",
                observed.get("contract_sha256"),
                sha256_bytes(contract_bytes or b""),
                findings,
            )


def verify_libreoffice_capability(
    receipt: dict[str, Any], report: dict[str, Any], findings: list[str]
) -> None:
    check = require_satisfied_check(report, "libreoffice_workbook_capability", findings)
    detail = check.get("detail", {}) if check else {}
    observed = receipt.get("workbook", {}).get("functional_capability")
    equal("receipt.workbook.functional_capability.report_join", observed, detail, findings)
    if not isinstance(observed, dict):
        findings.append("receipt.workbook.functional_capability:missing")
        return
    equal("receipt.workbook.functional_capability.schema_version", observed.get("schema_version"), "libreoffice-workbook-capability/1.0", findings)
    equal("receipt.workbook.functional_capability.status", observed.get("status"), "PASS", findings)
    equal("receipt.workbook.functional_capability.reason_code", observed.get("reason_code"), None, findings)
    equal("receipt.workbook.functional_capability.failure", observed.get("failure"), None, findings)
    equal("receipt.workbook.functional_capability.cached_result", observed.get("output", {}).get("cached_result"), 12.5, findings)
    equal("receipt.workbook.functional_capability.formula", observed.get("output", {}).get("formula"), "=SUM(A1:A3)", findings)
    require_sha256(observed.get("fixture", {}).get("sha256"), "receipt.workbook.functional_capability.fixture.sha256", findings)
    require_sha256(observed.get("output", {}).get("sha256"), "receipt.workbook.functional_capability.output.sha256", findings)
    cleanup = observed.get("cleanup", {})
    for field in ("profile_removed", "fixture_removed", "output_removed", "workspace_removed"):
        equal(f"receipt.workbook.functional_capability.cleanup.{field}", cleanup.get(field), True, findings)
    equal("receipt.workbook.functional_capability.cleanup.residue_paths", cleanup.get("residue_paths"), [], findings)
    equal("receipt.workbook.functional_capability.soffice.executable", observed.get("soffice", {}).get("executable"), receipt.get("workbook", {}).get("soffice_executable"), findings)
    equal("receipt.workbook.functional_capability.soffice.sha256", observed.get("soffice", {}).get("observed_sha256"), receipt.get("workbook", {}).get("soffice_executable_sha256"), findings)
    equal("receipt.workbook.functional_capability.python.executable", observed.get("python", {}).get("executable"), receipt.get("python", {}).get("executable"), findings)


def expected_inline_authority(fixture: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    expected = fixture.get("expected", {})
    contexts = expected.get("non_dimensioned_context_ids", [])
    periods = expected.get("period_ends", [])
    unit = expected.get("unit_id")
    authority: dict[str, Any] = {}
    for concept, values in expected.get("selected_authority", {}).items():
        authority[concept] = [
            {
                "context_ref": contexts[index],
                "period_end": periods[index],
                "unit_ref": unit,
                "value": values[index],
            }
            for index in range(min(len(contexts), len(periods), len(values)))
        ]
    dimensioned = expected.get("dimensioned_fact", {})
    quarantined = {
        "concept": dimensioned.get("concept"),
        "context_ref": dimensioned.get("context_ref"),
        "dimensions": {
            dimensioned.get("dimension"): dimensioned.get("member")
        },
        "value": dimensioned.get("value"),
    }
    return authority, quarantined


def verify_inline_xbrl(
    receipt: dict[str, Any],
    report: dict[str, Any],
    package_root: Path,
    is_v13: bool,
    findings: list[str],
) -> None:
    check = require_satisfied_check(report, "inline_xbrl_host_probe", findings)
    detail = check.get("detail", {}) if check else {}
    field = "inline_xbrl" if is_v13 else "inline_xbrl_probe"
    observed = receipt.get(field)
    expected_detail = (
        {key: value for key, value in detail.items() if key != "compatibility_prerequisite"}
        if is_v13 else detail
    )
    equal(f"receipt.{field}.report_join", observed, expected_detail, findings)
    if not isinstance(observed, dict):
        findings.append(f"receipt.{field}:missing")
        return
    equal(f"receipt.{field}.status", observed.get("status"), "PASS", findings)
    equal(f"receipt.{field}.lxml_worker_execution", observed.get("lxml_worker_execution"), "PASS", findings)
    equal(f"receipt.{field}.scratch_removed", observed.get("scratch_removed"), True, findings)
    equal(f"receipt.{field}.fact_count", observed.get("fact_count"), 7, findings)
    equal(f"receipt.{field}.context_count", observed.get("context_count"), 4, findings)
    equal(f"receipt.{field}.unit_count", observed.get("unit_count"), 1, findings)

    fixture_path = package_root / "assets" / "installed-inline-xbrl-capability-probe-v1.json"
    worker_path = package_root / "scripts" / "extract_inline_xbrl.py"
    schema_path = package_root / "assets" / "inline-xbrl-facts-v1.schema.json"
    fixture_bytes = read_regular_file(fixture_path, findings, "inline_xbrl_fixture")
    worker_bytes = read_regular_file(worker_path, findings, "inline_xbrl_worker")
    schema_bytes = read_regular_file(schema_path, findings, "inline_xbrl_result_schema")
    fixture = parse_json_bytes(fixture_bytes, findings, "inline_xbrl_fixture")
    if isinstance(fixture, dict):
        html_bytes = str(fixture.get("html", "")).encode("utf-8")
        expected_authority, expected_quarantined = expected_inline_authority(fixture)
        equal(f"receipt.{field}.fixture_sha256", observed.get("fixture_sha256"), sha256_bytes(fixture_bytes or b""), findings)
        equal(f"receipt.{field}.html_sha256", observed.get("html_sha256"), sha256_bytes(html_bytes), findings)
        equal("inline_xbrl_fixture.html_sha256", fixture.get("html_sha256"), sha256_bytes(html_bytes), findings)
        equal(f"receipt.{field}.selected_authority", observed.get("selected_non_dimensioned_authority"), expected_authority, findings)
        equal(f"receipt.{field}.dimension_quarantine", observed.get("quarantined_dimensioned_fact"), expected_quarantined, findings)
    if worker_bytes is not None:
        equal(f"receipt.{field}.worker_sha256", observed.get("worker_sha256"), sha256_bytes(worker_bytes), findings)
    if schema_bytes is not None:
        equal(f"receipt.{field}.result_schema_sha256", observed.get("result_schema_sha256"), sha256_bytes(schema_bytes), findings)
    equal(f"receipt.{field}.selected_python", observed.get("selected_python"), receipt.get("python", {}).get("executable"), findings)
    equal(f"receipt.{field}.selected_python_sha256", observed.get("selected_python_sha256"), receipt.get("python", {}).get("executable_sha256"), findings)
    require_sha256(observed.get("result_sha256"), f"receipt.{field}.result_sha256", findings)


def verify_filesystem_facts(facts: Any, root_kind: str, findings: list[str]) -> None:
    prefix = f"receipt.filesystem.{root_kind}.facts"
    if not isinstance(facts, dict):
        findings.append(f"{prefix}:missing")
        return
    expected_purpose = "run_root" if root_kind == "work_root" else "temp_root"
    equal(f"{prefix}.purpose", facts.get("purpose"), expected_purpose, findings)
    equal(f"{prefix}.outside_immutable_skill_root", facts.get("outside_immutable_skill_root"), True, findings)
    equal(f"{prefix}.real_run_directory_created", facts.get("real_run_directory_created"), False, findings)
    for field in (
        "created", "written", "flushed", "closed", "read_back", "bytes_match",
        "renamed", "statted", "deleted", "cleanup_verified",
    ):
        equal(f"{prefix}.{field}", facts.get(field), True, findings)
    if not isinstance(facts.get("requested_root"), str) or not facts.get("requested_root"):
        findings.append(f"{prefix}.requested_root:missing")
    if not isinstance(facts.get("canonical_requested_root"), str) or not facts.get("canonical_requested_root"):
        findings.append(f"{prefix}.canonical_requested_root:missing")
    volume = facts.get("volume_identity", {})
    if not isinstance(volume.get("device_id"), str) or not volume.get("device_id"):
        findings.append(f"{prefix}.volume_identity.device_id:missing")
    if not isinstance(volume.get("filesystem_type"), str) or not volume.get("filesystem_type"):
        findings.append(f"{prefix}.volume_identity.filesystem_type:missing")
    if not isinstance(volume.get("block_size_bytes"), int) or volume.get("block_size_bytes") < 1:
        findings.append(f"{prefix}.volume_identity.block_size_bytes:invalid")
    if not isinstance(facts.get("probe_payload_bytes"), int) or facts.get("probe_payload_bytes") < 1:
        findings.append(f"{prefix}.probe_payload_bytes:invalid")
    require_sha256(facts.get("probe_payload_sha256"), f"{prefix}.probe_payload_sha256", findings)
    equal(f"{prefix}.error", facts.get("error"), None, findings)


def verify_filesystem(
    receipt: dict[str, Any],
    report: dict[str, Any],
    package_root: Path,
    is_v13: bool,
    findings: list[str],
) -> None:
    work = require_satisfied_check(report, "work_root_writable", findings)
    temp = require_satisfied_check(report, "temp_root_writable", findings)
    filesystem = receipt.get("filesystem", {})
    if not is_v13:
        equal("receipt.filesystem.work_root.report_join", filesystem.get("work_root"), work.get("result") if work else None, findings)
        equal("receipt.filesystem.temp_root.report_join", filesystem.get("temp_root"), temp.get("result") if temp else None, findings)
        return
    for root_kind, check in (("work_root", work), ("temp_root", temp)):
        lane = filesystem.get(root_kind)
        expected_lane = {
            "result": check.get("result"),
            "facts": check.get("detail"),
        } if check else None
        equal(f"receipt.filesystem.{root_kind}.report_join", lane, expected_lane, findings)
        if isinstance(lane, dict):
            equal(f"receipt.filesystem.{root_kind}.result", lane.get("result"), "satisfied", findings)
            verify_filesystem_facts(lane.get("facts"), root_kind, findings)

    evaluation_check = require_satisfied_check(report, "disk_space_policy", findings)
    evaluation_wrapper = evaluation_check.get("detail", {}) if evaluation_check else {}
    evaluation = filesystem.get("disk_space_evaluation")
    equal(
        "receipt.filesystem.disk_space_evaluation.report_join",
        evaluation,
        evaluation_wrapper.get("evaluation") if evaluation_check else None,
        findings,
    )
    if not isinstance(evaluation, dict):
        findings.append("receipt.filesystem.disk_space_evaluation:missing")
        return

    prefix = "receipt.filesystem.disk_space_evaluation"
    equal(f"{prefix}.schema_version", evaluation.get("schema_version"), "excel-inflow-disk-space-evaluation/1.1", findings)
    equal(f"{prefix}.status", evaluation.get("status"), "PASS", findings)
    equal(f"{prefix}.total_violations", evaluation.get("total_violations"), 0, findings)
    equal(f"{prefix}.findings", evaluation.get("findings"), [], findings)
    equal(
        f"{prefix}.requested_lanes",
        sorted(evaluation.get("requested_lanes", [])),
        sorted(receipt.get("requested_lanes", [])),
        findings,
    )
    parse_timestamp(evaluation.get("observed_at"), f"{prefix}.observed_at", findings)

    profile_bytes = read_regular_file(
        package_root / "assets" / "deployment-profile.json",
        findings,
        "deployment_profile",
    )
    profile = parse_json_bytes(profile_bytes, findings, "deployment_profile")
    policy_binding = (
        profile.get("runtime_disk_space_policy", {})
        if isinstance(profile, dict) else {}
    )
    policy_relative = policy_binding.get("path")
    if (
        not isinstance(policy_relative, str) or not policy_relative or
        Path(policy_relative).is_absolute() or ".." in Path(policy_relative).parts
    ):
        findings.append(f"deployment_profile.runtime_disk_space_policy.path:unsafe:{policy_relative}")
        return
    policy_path = package_root / policy_relative
    policy_schema_path = package_root / "assets" / DISK_SPACE_POLICY_SCHEMA_NAME
    policy_bytes = read_regular_file(policy_path, findings, "disk_space_policy")
    policy_schema_bytes = read_regular_file(policy_schema_path, findings, "disk_space_policy_schema")
    policy = parse_json_bytes(policy_bytes, findings, "disk_space_policy")
    policy_evidence = evaluation.get("policy_evidence", {})
    policy_hash = sha256_bytes(policy_bytes or b"")
    policy_schema_hash = sha256_bytes(policy_schema_bytes or b"")
    if not isinstance(policy, dict):
        return
    equal(
        "deployment_profile.runtime_disk_space_policy.sha256",
        policy_binding.get("sha256"),
        policy_hash,
        findings,
    )
    equal("report.disk_space_policy.mode", evaluation_wrapper.get("mode"), "candidate", findings)
    equal(
        "report.disk_space_policy.policy_path",
        Path(evaluation_wrapper.get("policy_path", "")).resolve(),
        policy_path.resolve(),
        findings,
    )
    equal(
        "report.disk_space_policy.expected_policy_sha256",
        evaluation_wrapper.get("expected_policy_sha256"),
        policy_hash,
        findings,
    )
    equal(f"{prefix}.policy_evidence.policy_sha256", policy_evidence.get("policy_sha256"), policy_hash, findings)
    equal(f"{prefix}.policy_evidence.policy_schema_sha256", policy_evidence.get("policy_schema_sha256"), policy_schema_hash, findings)
    equal("disk_space_policy.policy_schema_sha256", policy.get("policy_schema_sha256"), policy_schema_hash, findings)
    equal(f"{prefix}.policy_evidence.policy_schema_version", policy_evidence.get("policy_schema_version"), policy.get("schema_version"), findings)

    measurement_pointer = policy.get("measurement_evidence", {})
    assets_root = policy_path.parent

    def bound_bytes(pointer: Any, label: str) -> bytes | None:
        if not isinstance(pointer, dict):
            findings.append(f"{label}:pointer_missing")
            return None
        declared = pointer.get("path")
        if not isinstance(declared, str) or Path(declared).is_absolute() or ".." in Path(declared).parts:
            findings.append(f"{label}:unsafe_path:{declared}")
            return None
        target = assets_root / declared
        value = read_regular_file(target, findings, label)
        equal(f"{label}.sha256", pointer.get("sha256"), sha256_bytes(value or b""), findings)
        return value

    measurement_bytes = bound_bytes(measurement_pointer, "disk_space_measurement")
    measurement_schema_bytes = bound_bytes({
        "path": measurement_pointer.get("schema_path"),
        "sha256": measurement_pointer.get("schema_sha256"),
    }, "disk_space_measurement_schema")
    measurement = parse_json_bytes(measurement_bytes, findings, "disk_space_measurement")
    equal(f"{prefix}.policy_evidence.measurement_evidence_sha256", policy_evidence.get("measurement_evidence_sha256"), sha256_bytes(measurement_bytes or b""), findings)
    equal(f"{prefix}.policy_evidence.measurement_schema_sha256", policy_evidence.get("measurement_schema_sha256"), sha256_bytes(measurement_schema_bytes or b""), findings)
    if isinstance(measurement, dict):
        equal(f"{prefix}.policy_evidence.measurement_schema_version", policy_evidence.get("measurement_schema_version"), measurement.get("schema_version"), findings)
        raw_expected = policy_evidence.get("raw_manifest_sha256", {})
        raw_pointers = {
            "sample_receipts": measurement.get("evidence_manifests", {}).get("sample_receipts"),
            **measurement.get("evidence_manifests", {}).get("corpora", {}),
        }
        for name in ("sample_receipts", "filings", "brokers", "workbook"):
            raw = bound_bytes(raw_pointers.get(name), f"disk_space_raw_manifest.{name}")
            equal(f"{prefix}.policy_evidence.raw_manifest_sha256.{name}", raw_expected.get(name), sha256_bytes(raw or b""), findings)

    requested = sorted(receipt.get("requested_lanes", []))
    lane = "combined" if requested == ["evidence", "workbook"] else requested[0] if len(requested) == 1 else None
    equal(f"{prefix}.selected_lane", evaluation.get("selected_lane"), lane, findings)
    floors = policy.get("floors", {}).get(lane, {}) if lane else {}
    declared = {
        "distinct_volumes": {
            "work_root": floors.get("distinct_volumes", {}).get("work_root", {}).get("min_free_bytes"),
            "temp_root": floors.get("distinct_volumes", {}).get("temp_root", {}).get("min_free_bytes"),
        },
        "shared_volume": floors.get("shared_volume", {}).get("min_free_bytes"),
    }
    equal(f"{prefix}.policy_floor_bytes", evaluation.get("policy_floor_bytes"), declared, findings)

    work_facts = filesystem.get("work_root", {}).get("facts", {})
    temp_facts = filesystem.get("temp_root", {}).get("facts", {})
    same_device = work_facts.get("volume_identity", {}).get("device_id") == temp_facts.get("volume_identity", {}).get("device_id")
    topology = "shared_volume" if same_device else "distinct_volumes"
    equal(f"{prefix}.selected_volume_topology", evaluation.get("selected_volume_topology"), topology, findings)
    required = evaluation.get("required_free_bytes", {})
    if evaluation.get("override_min_free_bytes") is None:
        equal(f"{prefix}.required_free_bytes", required, declared, findings)
    roots = evaluation.get("roots", {})
    for root_kind, facts in (("work_root", work_facts), ("temp_root", temp_facts)):
        observed = roots.get(root_kind, {})
        root_prefix = f"{prefix}.roots.{root_kind}"
        equal(f"{root_prefix}.volume_identity", observed.get("volume_identity"), facts.get("volume_identity"), findings)
        expected_required = required.get("shared_volume") if topology == "shared_volume" else required.get("distinct_volumes", {}).get(root_kind)
        equal(f"{root_prefix}.required_bytes", observed.get("required_bytes"), expected_required, findings)
        available = observed.get("available_bytes")
        required_bytes = observed.get("required_bytes")
        if isinstance(available, int) and isinstance(required_bytes, int):
            headroom = available - required_bytes
            equal(f"{root_prefix}.headroom_bytes", observed.get("headroom_bytes"), headroom, findings)
            equal(f"{root_prefix}.status", observed.get("status"), "PASS" if headroom >= 0 else "REFUSED", findings)
        else:
            findings.append(f"{root_prefix}.arithmetic:invalid_operands")


def verify_freshness(
    receipt: dict[str, Any], evaluated_at: dt.datetime, findings: list[str]
) -> None:
    freshness = receipt.get("freshness", {})
    equal("receipt.freshness.policy", freshness.get("policy"), "activation_transaction", findings)
    equal("receipt.freshness.max_age_seconds", freshness.get("max_age_seconds"), ACTIVATION_MAX_AGE_SECONDS, findings)
    equal("receipt.freshness.generated_at.top_level_join", freshness.get("generated_at"), receipt.get("generated_at"), findings)
    generated = parse_timestamp(freshness.get("generated_at"), "receipt.freshness.generated_at", findings)
    expires = parse_timestamp(freshness.get("expires_at"), "receipt.freshness.expires_at", findings)
    recorded_evaluation = parse_timestamp(freshness.get("evaluated_at"), "receipt.freshness.evaluated_at", findings)
    if generated is None or expires is None or recorded_evaluation is None:
        return
    equal(
        "receipt.freshness.exact_expiry",
        int((expires - generated).total_seconds()),
        ACTIVATION_MAX_AGE_SECONDS,
        findings,
    )
    if generated - recorded_evaluation > dt.timedelta(seconds=ACTIVATION_MAX_FUTURE_SKEW_SECONDS):
        findings.append("receipt.freshness.recorded_future_skew:exceeded")
    if generated - evaluated_at > dt.timedelta(seconds=ACTIVATION_MAX_FUTURE_SKEW_SECONDS):
        findings.append("receipt.freshness.current_future_skew:exceeded")
    current_status = "FRESH" if evaluated_at < expires else "EXPIRED"
    equal("receipt.freshness.current_status", freshness.get("status"), current_status, findings)
    if recorded_evaluation >= expires:
        equal("receipt.freshness.recorded_status", freshness.get("status"), "EXPIRED", findings)


def verify_capability_semantics(
    receipt: dict[str, Any],
    report: dict[str, Any],
    package_root: Path,
    evaluated_at: dt.datetime,
    findings: list[str],
) -> bool:
    schema_version = receipt.get("schema_version")
    if schema_version not in (RECEIPT_V12, RECEIPT_V13):
        findings.append(f"receipt.schema_version:unsupported:{schema_version}")
        return False
    is_v13 = schema_version == RECEIPT_V13
    verify_runtime_compatibility(receipt, report, package_root, is_v13, findings)
    verify_libreoffice_capability(receipt, report, findings)
    verify_inline_xbrl(receipt, report, package_root, is_v13, findings)
    verify_filesystem(receipt, report, package_root, is_v13, findings)
    if is_v13:
        equal("receipt.status", receipt.get("status"), "HOST_READY", findings)
        equal("receipt.readiness_scope", receipt.get("readiness_scope"), "inactive_candidate_slot_only", findings)
        candidate_ready = receipt.get("candidate_slot_ready")
        if not isinstance(candidate_ready, bool):
            findings.append("receipt.candidate_slot_ready:not_boolean")
        refusal_reason = receipt.get("candidate_slot_refusal_reason")
        if candidate_ready is True:
            equal("receipt.candidate_slot_refusal_reason", refusal_reason, None, findings)
        elif not isinstance(refusal_reason, str) or not refusal_reason:
            findings.append("receipt.candidate_slot_refusal_reason:missing")
        equal("receipt.production_promotion_eligible", receipt.get("production_promotion_eligible"), False, findings)
        if not isinstance(receipt.get("production_promotion_refusal_reason"), str) or not receipt.get("production_promotion_refusal_reason"):
            findings.append("receipt.production_promotion_refusal_reason:missing")
        verify_freshness(receipt, evaluated_at, findings)
        equal("receipt.freshness.activation_status", receipt.get("freshness", {}).get("status"), "FRESH", findings)
    return is_v13


def verify(args: argparse.Namespace) -> dict[str, Any]:
    findings: list[str] = []
    checks = 0
    artifact_root = Path(args.artifact_dir).resolve()
    package_root = Path(args.package_root).resolve()
    pointer_path = artifact_root / POINTER_NAME
    evaluated_at = (
        parse_timestamp(args.evaluated_at, "oracle.evaluated_at", findings)
        if args.evaluated_at
        else dt.datetime.now(dt.timezone.utc)
    )
    if evaluated_at is None:
        return {"status": "FAIL", "checks": checks, "total_violations": len(findings), "findings": findings}

    pointer_bytes_before = read_regular_file(pointer_path, findings, "pointer")
    pointer = parse_json_bytes(pointer_bytes_before, findings, "pointer")
    if not isinstance(pointer, dict):
        return {"status": "FAIL", "checks": checks, "total_violations": len(findings), "findings": findings}
    checks += 1
    equal("pointer.schema_version", pointer.get("schema_version"), "excel-inflow-host-preflight-pointer/1.1", findings)
    for field in ("report_file", "receipt_file"):
        if not safe_pointer_name(pointer.get(field)):
            findings.append(f"pointer.{field}:unsafe_target")
    if findings:
        return {"status": "FAIL", "checks": checks, "total_violations": len(findings), "findings": findings}

    report_path = artifact_root / pointer["report_file"]
    receipt_path = artifact_root / pointer["receipt_file"]
    report_bytes = read_regular_file(report_path, findings, "report")
    receipt_bytes = read_regular_file(receipt_path, findings, "receipt")
    report = parse_json_bytes(report_bytes, findings, "report")
    receipt = parse_json_bytes(receipt_bytes, findings, "receipt")
    if not isinstance(report, dict) or not isinstance(receipt, dict):
        return {"status": "FAIL", "checks": checks, "total_violations": len(findings), "findings": findings}

    # Canonical final bytes and pointer-last stable read.
    equal("pointer.canonical_final_bytes", pointer_bytes_before, canonical_json(pointer, newline=True), findings)
    equal("report.canonical_final_bytes", report_bytes, canonical_json(report, newline=True), findings)
    equal("receipt.canonical_final_bytes", receipt_bytes, canonical_json(receipt, newline=True), findings)
    pointer_bytes_after = read_regular_file(pointer_path, findings, "pointer_recheck")
    equal("pointer.final_bytes_stable", pointer_bytes_after, pointer_bytes_before, findings)
    temporary_names = [item.name for item in artifact_root.iterdir() if ".tmp-" in item.name]
    equal("pointer.no_partial_generation", temporary_names, [], findings)
    checks += 5

    report_digest = sha256_bytes(report_bytes or b"")
    receipt_bytes_digest = sha256_bytes(receipt_bytes or b"")
    equal("pointer.report_sha256", pointer.get("report_sha256"), report_digest, findings)
    equal("pointer.receipt_sha256", pointer.get("receipt_sha256"), receipt_bytes_digest, findings)
    equal("pointer.report_target", pointer.get("report_file"), f"{REPORT_PREFIX}{report_digest}.json", findings)
    equal("pointer.receipt_target", pointer.get("receipt_file"), f"{RECEIPT_PREFIX}{receipt_bytes_digest}.json", findings)
    equal("receipt.report_sha256", receipt.get("runtime_doctor_sha256"), report_digest, findings)
    checks += 5

    receipt_body = dict(receipt)
    receipt_self_declared = receipt_body.pop("receipt_sha256", None)
    receipt_self_observed = sha256_bytes(canonical_json(receipt_body, newline=True))
    equal("receipt.self_sha256", receipt_self_declared, receipt_self_observed, findings)
    equal("pointer.receipt_self_sha256", pointer.get("receipt_self_sha256"), receipt_self_observed, findings)
    checks += 2

    expected_status = "HOST_READY" if receipt.get("status") == "HOST_READY" else "HOST_REFUSED"
    equal("pointer.status", pointer.get("status"), expected_status, findings)
    equal("receipt.generated_at", receipt.get("generated_at"), report.get("generated_at"), findings)
    equal("receipt.requested_lanes", receipt.get("requested_lanes"), report.get("requested_lanes"), findings)
    equal("receipt.host", receipt.get("host"), report.get("host"), findings)
    parse_timestamp(receipt.get("generated_at"), "receipt.generated_at", findings)
    checks += 5

    # Report-to-receipt bindings are recomputed by field, never trusted from a receipt hash.
    node_check = find_check(report, "node_interpreter")
    python_custody = find_check(report, "python_interpreter_custody")
    python_version = find_check(report, "python_minimum_version")
    python_closure = find_check(report, "python_single_interpreter_lane_closure")
    soffice_check = find_check(report, "soffice_available")
    filings_check = find_check(report, "filings_extraction_probe")
    source_check = find_check(report, "active_source_identity")
    required_checks = {
        "node_interpreter": node_check,
        "python_interpreter_custody": python_custody,
        "python_minimum_version": python_version,
        "python_single_interpreter_lane_closure": python_closure,
        "soffice_available": soffice_check,
        "filings_extraction_probe": filings_check,
        "active_source_identity": source_check,
    }
    for name, value in required_checks.items():
        if value is None:
            findings.append(f"report.check:{name}:missing_or_duplicate")
    if all(value is not None for value in required_checks.values()):
        equal("receipt.node.executable", receipt.get("node", {}).get("executable"), node_check["detail"].get("resolved_executable"), findings)
        equal("receipt.node.executable_sha256", receipt.get("node", {}).get("executable_sha256"), node_check["detail"].get("executable_sha256"), findings)
        equal("receipt.node.version", receipt.get("node", {}).get("version"), report.get("host", {}).get("node_version"), findings)
        equal("receipt.python.executable", receipt.get("python", {}).get("executable"), python_custody["detail"].get("resolved_executable"), findings)
        equal("receipt.python.executable_sha256", receipt.get("python", {}).get("executable_sha256"), python_custody["detail"].get("executable_sha256"), findings)
        equal("receipt.python.version", receipt.get("python", {}).get("version"), python_version["detail"].get("running_version"), findings)
        equal("receipt.python.required_modules", receipt.get("python", {}).get("required_modules"), python_closure["detail"].get("required"), findings)
        equal("receipt.python.per_module", receipt.get("python", {}).get("per_module"), python_closure["detail"].get("per_module"), findings)
        equal("receipt.python.module_versions", receipt.get("python", {}).get("module_versions"), python_closure["detail"].get("module_versions"), findings)
        equal("receipt.workbook.soffice_executable", receipt.get("workbook", {}).get("soffice_executable"), soffice_check["detail"].get("resolved_executable"), findings)
        equal("receipt.workbook.soffice_executable_sha256", receipt.get("workbook", {}).get("soffice_executable_sha256"), soffice_check["detail"].get("executable_sha256"), findings)
        equal("receipt.workbook.soffice_version", receipt.get("workbook", {}).get("soffice_version"), soffice_check["detail"].get("version"), findings)
        equal("receipt.mandatory_filings_probe", receipt.get("mandatory_filings_probe"), filings_check.get("detail"), findings)
        checks += 13

    # Executable custody comes from independently named expected paths and live bytes.
    executable_expectations = (
        ("node", "executable", "executable_sha256", args.expected_node_executable),
        ("python", "executable", "executable_sha256", args.expected_python_executable),
        ("workbook", "soffice_executable", "soffice_executable_sha256", args.expected_soffice_executable),
    )
    for group, path_field, hash_field, expected_path in executable_expectations:
        # Preserve the selected interpreter path exactly.  A virtualenv's
        # executable is often a symlink to the system binary; resolving that
        # symlink here would certify a different selection from the one the
        # caller and runtime report actually placed under custody.
        expected = Path(os.path.abspath(expected_path))
        observed_path = receipt.get(group, {}).get(path_field)
        equal(f"receipt.{group}.{path_field}.expected", observed_path, str(expected), findings)
        observed_hash = executable_sha256(expected, findings, f"expected_executable:{group}")
        equal(f"receipt.{group}.{hash_field}.live", receipt.get(group, {}).get(hash_field), observed_hash, findings)
        checks += 2

    # The installed filings fixture hash is recomputed from shipped base64 bytes.
    fixture_path = package_root / "assets" / "installed-filings-capability-probe-v1.json"
    fixture_bytes = read_regular_file(fixture_path, findings, "filings_fixture")
    fixture = parse_json_bytes(fixture_bytes, findings, "filings_fixture")
    if isinstance(fixture, dict):
        try:
            fixture_digest = sha256_bytes(fixture_bytes or b"")
            pdf_digest = sha256_bytes(base64.b64decode(fixture.get("pdf_base64", ""), validate=True))
            equal("receipt.mandatory_filings_probe.fixture_sha256", receipt.get("mandatory_filings_probe", {}).get("fixture_sha256"), fixture_digest, findings)
            equal("filings_fixture.declared_pdf_sha256", fixture.get("pdf_sha256"), pdf_digest, findings)
            equal("receipt.mandatory_filings_probe.pdf_sha256", receipt.get("mandatory_filings_probe", {}).get("pdf_sha256"), pdf_digest, findings)
            checks += 3
        except (ValueError, TypeError) as error:
            findings.append(f"filings_fixture:invalid_base64:{error}")

    is_v13 = verify_capability_semantics(
        receipt,
        report,
        package_root,
        evaluated_at,
        findings,
    )
    checks += 4

    # Whole-package identity is independently walked and joined to the external archive/attestation.
    inventory_files, inventory_sha256 = inventory_identity(package_root, findings)
    archive_path = Path(args.package_archive).resolve() if args.package_archive else Path(f"{package_root}.tar")
    attestation_path = Path(args.package_attestation).resolve() if args.package_attestation else Path(f"{package_root}.attestation.json")
    archive_sha256 = file_sha256(archive_path, findings, "package_archive")
    manifest_bytes = read_regular_file(package_root / "release-manifest.json", findings, "release_manifest")
    manifest = parse_json_bytes(manifest_bytes, findings, "release_manifest")
    attestation_bytes = read_regular_file(attestation_path, findings, "package_attestation")
    attestation = parse_json_bytes(attestation_bytes, findings, "package_attestation")
    if isinstance(manifest, dict) and isinstance(attestation, dict) and archive_sha256:
        attestation_body = dict(attestation)
        declared_attestation_sha = attestation_body.pop("attestation_sha256", None)
        observed_attestation_sha = sha256_bytes(canonical_json(attestation_body, newline=False))
        equal("package_attestation.self_sha256", declared_attestation_sha, observed_attestation_sha, findings)
        equal("package_attestation.inventory.files", attestation.get("package", {}).get("complete_package_inventory", {}).get("files"), inventory_files, findings)
        equal("package_attestation.inventory.sha256", attestation.get("package", {}).get("complete_package_inventory", {}).get("sha256"), inventory_sha256, findings)
        equal("package_attestation.archive.sha256", attestation.get("package", {}).get("archive", {}).get("sha256"), archive_sha256, findings)
        equal("package_attestation.release_manifest_sha256", attestation.get("package", {}).get("release_manifest_sha256"), inventory_files.get("release-manifest.json"), findings)
        expected_identity = expected_product_identity(manifest, inventory_sha256, archive_sha256)
        equal("package_attestation.product_identity", attestation.get("package", {}).get("product_identity"), expected_identity, findings)
        checks += 6

        manifest_identity = manifest.get("identity", {})
        source = manifest_identity.get("source", {})
        package = manifest_identity.get("package", {})
        closure = package.get("runtime_code_closure", {})
        source_receipt = receipt.get("source_identity", {})
        source_report = source_check.get("detail", {}) if source_check else {}
        expected_source = {
            "repository": source.get("repository"),
            "source_commit": source.get("commit_sha"),
            "source_tree": source.get("tree_sha"),
            "source_worktree_dirty": manifest.get("sourceWorktreeDirty"),
            "skill_version": manifest.get("skillVersion"),
            "package_mode": package.get("mode"),
            "deployment_status": args.expected_deployment_status,
            "closure_check_status": "match",
            "active_runtime_code_closure_sha256": closure.get("sha256"),
            "declared_runtime_code_closure_sha256": closure.get("sha256"),
            "complete_package_inventory_sha256": inventory_sha256,
            "archive_sha256": archive_sha256,
            "release_package_attestation_sha256": observed_attestation_sha,
            "installation_identity": args.expected_installation_identity,
        }
        equal("receipt.source_identity.expected_package_identity", source_receipt, expected_source, findings)
        for name, expected in expected_source.items():
            equal(f"report.active_source_identity.{name}", source_report.get(name), expected, findings)
        checks += 1 + len(expected_source)

        if is_v13:
            for field in (
                "repository", "skill_version", "package_mode",
            ):
                if not isinstance(source_receipt.get(field), str) or not source_receipt.get(field):
                    findings.append(f"receipt.source_identity.{field}:candidate_value_missing")
            if args.expected_deployment_status == "installed_candidate":
                if not isinstance(source_receipt.get("installation_identity"), str) or not source_receipt.get("installation_identity"):
                    findings.append("receipt.source_identity.installation_identity:candidate_value_missing")
            for field in ("source_commit", "source_tree"):
                value = source_receipt.get(field)
                if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{40}", value) is None:
                    findings.append(f"receipt.source_identity.{field}:candidate_value_invalid")
            for field in (
                "active_runtime_code_closure_sha256",
                "declared_runtime_code_closure_sha256",
                "complete_package_inventory_sha256",
                "archive_sha256",
                "release_package_attestation_sha256",
            ):
                require_sha256(
                    source_receipt.get(field),
                    f"receipt.source_identity.{field}",
                    findings,
                )
            equal("receipt.source_identity.closure_check_status", source_receipt.get("closure_check_status"), "match", findings)
            equal(
                "receipt.source_identity.deployment_status",
                source_receipt.get("deployment_status"),
                args.expected_deployment_status,
                findings,
            )
            equal(
                "receipt.source_identity.runtime_closure_join",
                source_receipt.get("active_runtime_code_closure_sha256"),
                source_receipt.get("declared_runtime_code_closure_sha256"),
                findings,
            )
            expected_candidate_ready = (
                args.expected_deployment_status == "installed_candidate" and
                isinstance(args.expected_installation_identity, str) and
                bool(args.expected_installation_identity) and
                source_receipt.get("source_worktree_dirty") is False and
                source_receipt.get("closure_check_status") == "match" and
                source_receipt.get("deployment_status") == "installed_candidate" and
                source_receipt.get("active_runtime_code_closure_sha256") ==
                    source_receipt.get("declared_runtime_code_closure_sha256")
            )
            equal(
                "receipt.candidate_slot_ready.attested_source_join",
                receipt.get("candidate_slot_ready"),
                expected_candidate_ready,
                findings,
            )
            refusal_reason = receipt.get("candidate_slot_refusal_reason")
            if expected_candidate_ready:
                equal("receipt.candidate_slot_refusal_reason.attested_source_join", refusal_reason, None, findings)
            elif not isinstance(refusal_reason, str) or not refusal_reason:
                findings.append("receipt.candidate_slot_refusal_reason.attested_source_join:missing")

    audit_status = "PASS" if not findings else "FAIL"
    activation_eligible = bool(
        is_v13 and receipt.get("candidate_slot_ready") is True and not findings
    )
    status = (
        "FAIL" if findings else
        "PASS" if activation_eligible else
        "NOT_ACTIVATION_ELIGIBLE" if is_v13 else
        "LEGACY_NOT_ACTIVATION_ELIGIBLE"
    )
    return {
        "status": status,
        "audit_status": audit_status,
        "activation_eligible": activation_eligible,
        "receipt_schema_version": receipt.get("schema_version"),
        "checks": checks,
        "total_violations": len(findings),
        "findings": findings,
        "proof": {
            "report_sha256": report_digest,
            "receipt_bytes_sha256": receipt_bytes_digest,
            "receipt_self_sha256": receipt_self_observed,
            "complete_package_inventory_sha256": inventory_sha256,
            "archive_sha256": archive_sha256,
            "pointer_final_bytes_sha256": sha256_bytes(pointer_bytes_before or b""),
            "pointer_final_bytes_stable": pointer_bytes_before == pointer_bytes_after,
        },
    }


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--artifact-dir", required=True)
    value.add_argument("--package-root", required=True)
    value.add_argument("--package-archive")
    value.add_argument("--package-attestation")
    value.add_argument("--expected-node-executable", required=True)
    value.add_argument("--expected-python-executable", required=True)
    value.add_argument("--expected-soffice-executable", required=True)
    value.add_argument("--expected-deployment-status", required=True)
    value.add_argument("--expected-installation-identity")
    value.add_argument("--evaluated-at")
    return value


def main() -> int:
    result = verify(parser().parse_args())
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0 if result["status"] in (
        "PASS", "NOT_ACTIVATION_ELIGIBLE", "LEGACY_NOT_ACTIVATION_ELIGIBLE"
    ) else 1


if __name__ == "__main__":
    sys.exit(main())
