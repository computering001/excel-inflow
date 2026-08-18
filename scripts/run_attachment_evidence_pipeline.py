#!/usr/bin/env python3
"""Run filings, broker and DCS evidence as one resumable production transaction.

The component controllers remain the only owners of their respective evidence
lanes.  This controller aggregates their typed states, materialises a resolved
attachment-ingress spec only after every declared lane passes, and invokes the
immutable ingress compiler once.  Internal preparation work never becomes a
request for the user to re-upload unchanged evidence.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
import atexit
from pathlib import Path
from typing import Any

from archive_broker_pages import archive_pdf_pages
from delivery_constitution import assert_broker_failure_degrades
from workflow_state import assert_state, assert_transition
from zero_broker_authority import apply_zero_broker_authority
from experience_trace import ExperienceTrace, write_trace


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNTIME_MANIFEST = ROOT / "assets" / "attachment-evidence-runtime-members.json"
USER_BLOCKERS = {"USER_EVIDENCE", "USER_DECISION", "FATAL_SOURCE"}
BROKER_SKIP_PHRASE = "continue without brokers"


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def sha256_file(target: Path) -> str:
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def broker_pack_selected_value_count(pack: dict[str, Any]) -> int:
    """Count usable values on the normalized broker-pack contract surface."""
    return sum(
        1
        for house in pack.get("houses") or []
        for series in (house.get("estimates") or {}).values()
        if isinstance(series, list)
        for value in series
        if isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def sha256_value(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def read_json(target: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(target.read_text("utf-8"))
    except Exception as error:
        raise ValueError(f"{label} is not readable JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def atomic_json(target: Path, value: Any) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(canonical_bytes(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def resolve(base: Path, value: str | None) -> Path | None:
    if not value:
        return None
    target = Path(value)
    return target.resolve() if target.is_absolute() else (base / target).resolve()


def verify_broker_intake_choice(spec: dict[str, Any], spec_path: Path) -> tuple[dict[str, Any], Path]:
    choice_path = resolve(spec_path.parent, spec.get("broker_intake_choice_path"))
    if choice_path is None or not choice_path.is_file():
        raise ValueError(
            "The visible Brokers milestone has no sealed upload-or-skip choice. "
            "Run scripts/run_broker_intake.mjs and do not infer skip from zero files."
        )
    choice = read_json(choice_path, "broker intake choice")
    if choice.get("schema_version") != "broker-intake-choice/1.0":
        raise ValueError("Broker intake choice has the wrong schema version")
    if choice.get("run_id") != spec.get("run_id"):
        raise ValueError("Broker intake choice belongs to another run")
    body = {key: value for key, value in choice.items() if key != "receipt_sha256"}
    if choice.get("receipt_sha256") != sha256_value(body):
        raise ValueError("Broker intake choice self-hash does not bind its payload")
    issuer = choice.get("issuer_identity")
    if not isinstance(issuer, dict) or not str(issuer.get("name") or "").strip():
        raise ValueError("Broker intake choice omits issuer identity")
    if choice.get("issuer_identity_sha256") != sha256_value(issuer):
        raise ValueError("Broker intake choice issuer identity hash does not match")
    for field in ("filings_receipt_sha256", "runtime_closure_sha256"):
        value = choice.get(field)
        if not isinstance(value, str) or len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
            raise ValueError(f"Broker intake choice {field} is not sha256")
    attachments = choice.get("attachments")
    if not isinstance(attachments, list) or len(attachments) > 10:
        raise ValueError("Broker intake choice attachments are invalid")
    intake_state = choice.get("intake_state")
    broker = spec.get("broker")
    if intake_state == "explicitly_skipped":
        if attachments or choice.get("choice_phrase") != BROKER_SKIP_PHRASE or broker:
            raise ValueError("Explicit broker skip conflicts with supplied broker evidence")
        if choice.get("authority_state") != "zero":
            raise ValueError("Explicit broker skip did not seal zero broker authority")
    elif intake_state == "supplied":
        if not broker or not (1 <= len(attachments) <= 10):
            raise ValueError("Supplied broker choice requires one broker lane and 1-10 attachments")
        request_path = resolve(spec_path.parent, broker.get("request_path"))
        if request_path is None or not request_path.is_file():
            raise ValueError("Supplied broker choice points at an absent broker request")
        request = read_json(request_path, "broker request for intake binding")
        documents = request.get("documents")
        if not isinstance(documents, list) or len(documents) != len(attachments):
            raise ValueError("Broker intake choice attachment count does not match broker request")
        chosen = {str(item.get("attachment_id")): item for item in attachments}
        if len(chosen) != len(attachments):
            raise ValueError("Broker intake choice has duplicate attachment ids")
        for document in documents:
            document_id = str(document.get("document_id") or "")
            selected = chosen.get(document_id)
            source_path = resolve(request_path.parent, document.get("path"))
            if selected is None or source_path is None or not source_path.is_file():
                raise ValueError(f"Broker intake choice does not bind document {document_id}")
            actual_sha = sha256_file(source_path)
            if selected.get("sha256") != actual_sha:
                raise ValueError(f"Broker intake choice hash does not match document {document_id}")
            expected = document.get("expected_sha256")
            if expected is not None and expected != actual_sha:
                raise ValueError(f"Broker request expected hash does not match document {document_id}")
    else:
        raise ValueError("Broker intake choice is neither supplied nor explicitly skipped")
    return choice, choice_path


def runtime_closure() -> str:
    manifest = read_json(RUNTIME_MANIFEST, "attachment evidence runtime manifest")
    members = manifest.get("members")
    if (
        manifest.get("schema_version") != "attachment-evidence-runtime-members/1.0"
        or not isinstance(members, list)
        or not members
        or len(members) != len(set(members))
    ):
        raise ValueError("Attachment evidence runtime manifest is malformed")
    hashes: dict[str, str] = {}
    for relative in members:
        if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
            raise ValueError(f"Invalid attachment evidence runtime member: {relative!r}")
        target = ROOT / relative
        if not target.is_file():
            raise FileNotFoundError(f"Attachment evidence runtime member is absent: {relative}")
        hashes[relative] = sha256_file(target)
    nested_manifests = manifest.get("runtime_manifests", [])
    if not isinstance(nested_manifests, list) or len(nested_manifests) != len(set(nested_manifests)):
        raise ValueError("Attachment evidence nested runtime manifest list is malformed")
    for manifest_relative in nested_manifests:
        if (
            not isinstance(manifest_relative, str)
            or manifest_relative.startswith("/")
            or ".." in Path(manifest_relative).parts
        ):
            raise ValueError(f"Invalid nested runtime manifest: {manifest_relative!r}")
        nested_path = ROOT / manifest_relative
        nested = read_json(nested_path, f"nested runtime manifest {manifest_relative}")
        nested_members = nested.get("members")
        if not isinstance(nested_members, list) or not nested_members:
            raise ValueError(f"Nested runtime manifest {manifest_relative} has no members")
        hashes[manifest_relative] = sha256_file(nested_path)
        for relative in nested_members:
            if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
                raise ValueError(f"Invalid nested runtime member: {relative!r}")
            target = ROOT / relative
            if not target.is_file():
                raise FileNotFoundError(f"Nested runtime member is absent: {relative}")
            hashes[relative] = sha256_file(target)
    return sha256_value(hashes)


def run(
    command: list[str], *, timeout_seconds: int | None = None
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=HERE,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else error.stdout
        stderr = error.stderr.decode() if isinstance(error.stderr, bytes) else error.stderr
        return subprocess.CompletedProcess(
            command,
            124,
            stdout or "",
            (stderr or "")
            + f"\ncontroller timeout after {timeout_seconds} seconds",
        )


def lane_timeout_budget(kind: str, request_path: Path) -> int:
    """Derive a finite lane budget from the source inventory, never one blob size."""
    request: dict[str, Any] = {}
    try:
        request = read_json(request_path, f"{kind} timeout request")
    except (OSError, ValueError):
        pass
    document_count = len(request.get("documents") or [])
    if kind == "broker":
        return min(3600, 300 + 180 * max(1, document_count))
    if kind == "filings":
        return min(2400, 300 + 120 * max(1, document_count))
    return min(1200, 180 + 30 * max(1, document_count))


def lane_command(kind: str, declaration: dict[str, Any], base: Path, output_root: Path) -> list[str]:
    request = resolve(base, declaration.get("request_path"))
    if kind == "filings":
        command = [
            "node",
            str(HERE / "run_filings_pipeline.mjs"),
            str(request),
            "--out",
            str(output_root / kind),
        ]
        response = resolve(base, declaration.get("responses_path"))
        if response is not None:
            command.extend(["--responses", str(response)])
        return command
    command = [
        sys.executable,
        str(HERE / ("run_broker_pipeline.py" if kind == "broker" else "run_dcs_pipeline.py")),
        str(request),
        "--out",
        str(output_root / kind),
    ]
    for field, option in (("responses_path", "--responses"), ("crosswalk_path", "--crosswalk")):
        target = resolve(base, declaration.get(field))
        if target is not None and (kind == "broker" or field != "responses_path"):
            command.extend([option, str(target)])
    return command


def run_lane(kind: str, declaration: dict[str, Any], base: Path, output_root: Path) -> dict[str, Any]:
    state_path = output_root / kind / f"{kind}-run-state.json"
    command = lane_command(kind, declaration, base, output_root)
    request_path = Path(command[2])
    if not request_path.is_file():
        return {
            "schema_version": f"{kind}-run-state/1.0",
            "pipeline_status": "BLOCKED_INTERNAL",
            "user_blocking": False,
            "blocker_class": "INTERNAL_WORK",
            "tasks": [],
            "artifacts": {},
            "artifact_sha256": {},
            "summary": {"message": f"Internal {kind} request declaration is absent: {request_path}"},
        }
    state_before = None
    if state_path.is_file():
        try:
            state_before = state_path.read_bytes()
        except OSError:
            state_before = None
    completed = run(
        command,
        timeout_seconds=lane_timeout_budget(kind, request_path),
    )
    # A lane state is trusted only when THIS invocation stands behind it: the
    # controller exited cleanly (0 = closed, 2 = typed non-terminal state), or
    # it rewrote the state file during this run. A crash that left yesterday's
    # bytes untouched must fall through to the no-state classification below,
    # never resume a previous transaction's verdict.
    state_is_current = completed.returncode in {0, 2} or (
        state_path.is_file()
        and (state_before is None or state_path.read_bytes() != state_before)
    )
    if state_path.is_file() and state_is_current:
        try:
            state = read_json(state_path, f"{kind} run state")
            if not isinstance(state.get("user_blocking"), bool):
                raise ValueError(f"{kind} lane state omits a boolean user_blocking field")
            assert_state(
                kind,
                str(state.get("pipeline_status") or ""),
                state.get("blocker_class"),
                state.get("user_blocking") is True,
            )
        except (ValueError, OSError) as error:
            return {
                "schema_version": f"{kind}-run-state/1.0",
                "pipeline_status": "BLOCKED_INTERNAL",
                "user_blocking": False,
                "blocker_class": "INTERNAL_WORK",
                "tasks": [],
                "artifacts": {},
                "artifact_sha256": {},
                "summary": {
                    "terminal_reason": "invalid_lane_state",
                    "message": str(error),
                },
            }
        if (
            kind == "broker"
            and state.get("pipeline_status") not in CLOSED_LANE_STATUSES
            and state.get("blocker_class") == "INTERNAL_WORK"
        ):
            # The broker lane is optional. Give the model-host-owned path one
            # normal pass, then execute the controller's negative-only circuit
            # breaker in the same attachment transaction. This preserves all
            # source bytes/page images, selects no disputed value, and prevents
            # an internal task packet from becoming a terminal chat response.
            closed = run(
                [*command, "--close-optional"],
                timeout_seconds=min(900, lane_timeout_budget(kind, request_path)),
            )
            if closed.returncode in {0, 2} and state_path.is_file():
                state = read_json(state_path, "broker optional-close state")
                assert_state(
                    kind,
                    str(state.get("pipeline_status") or ""),
                    state.get("blocker_class"),
                    state.get("user_blocking") is True,
                )
        return state
    detail = (completed.stderr or completed.stdout).strip()[-4000:]
    # An absent/corrupt caller-supplied raw file is the one no-state failure
    # that genuinely belongs to the user.  Missing internal declarations and
    # controller defects stay internal so the host cannot turn them into a
    # spurious re-upload loop.
    source_failure = any(token in detail.lower() for token in (
        "source is absent", "source hash does not match",
    ))
    blocker = "FATAL_SOURCE" if source_failure else "INTERNAL_WORK"
    return {
        "schema_version": f"{kind}-run-state/1.0",
        "pipeline_status": "BLOCKED_INPUT" if source_failure else "BLOCKED_INTERNAL",
        "user_blocking": source_failure,
        "blocker_class": blocker,
        "tasks": [],
        "artifacts": {},
        "artifact_sha256": {},
        "summary": {"message": detail or f"{kind} controller exited without a state"},
    }


def _model_owned_broker_demand(*, request: dict[str, Any], spec: dict[str, Any], filings: dict[str, Any]) -> dict[str, Any]:
    historical = list(filings.get("historical_periods") or [])
    forecast = list(filings.get("forecast_periods") or [])
    if len(forecast) != 3 or not historical or not filings.get("reporting_currency") or not filings.get("units"):
        raise ValueError("Model-owned broker demand requires complete filings period/currency/unit context.")
    ontology_path = ROOT / "assets" / "economic-ontology-v2.json"
    ontology = read_json(ontology_path, "economic ontology")
    metric_ids = list(ontology.get("standard_broker_demand") or [])
    rows_by_metric: dict[str, tuple[str, dict[str, Any]]] = {}
    for section in ("income_statement", "cash_flow"):
        for row in filings.get(section) or []:
            candidates = [row.get("broker_metric_id"), row.get("semantic_role"), row.get("row_id")]
            for candidate in candidates:
                if candidate in metric_ids and candidate not in rows_by_metric:
                    rows_by_metric[str(candidate)] = (section, row)
    nodes: list[dict[str, Any]] = []
    source_rows: set[str] = set()
    for metric_id in metric_ids:
        section, row = rows_by_metric.get(metric_id, ("income_statement" if metric_id in {"revenue","ebit","adjusted_ebitda","depreciation_and_amortisation","effective_tax_rate"} else "cash_flow", {}))
        source_line_id = str(row.get("source_line_id") or row.get("row_id") or "").strip() or None
        if source_line_id:
            source_rows.add(source_line_id)
        label = str(row.get("label") or metric_id.replace("_", " ").title())
        source_backed = bool(source_line_id)
        definition_signature = sha256_value({
            "metric_id": metric_id,
            "section": section,
            "source_line_id": source_line_id,
            "label": label,
            "units": filings["units"],
            "reporting_currency": filings["reporting_currency"],
        })
        for index, period_end in enumerate(forecast):
            nodes.append({
                "node_id": f"model_demand.{metric_id}.fy{index + 1}",
                "node_kind": "model_demand",
                "section": section,
                "source_line_id": source_line_id,
                "metric_id": metric_id,
                "label": label,
                "parent_label": row.get("parent_label"),
                "period_end": period_end,
                "material": True,
                "source_backed": source_backed,
                "broker_demand_eligible": True,
                "house_requirement": "headline_anchor" if metric_id in {"ebit", "adjusted_ebitda"} else "required",
                "allowed_authorities": ["company_guidance", "selected_broker", "user_assumption", "historical_inference", "explicit_zero"],
                "definition_signature_sha256": definition_signature,
                "consumer_ids": [f"forecast_authority.{metric_id}.{period_end}"],
            })
    nodes.sort(key=lambda item: item["node_id"])
    body = {
        "schema_version": "pre-broker-model-demand/2.0",
        "run_id": str(request.get("run_id") or spec.get("run_id") or "unknown"),
        "as_of": historical[-1],
        "reporting_currency": filings["reporting_currency"],
        "units": filings["units"],
        "forecast_periods": forecast,
        "ontology_sha256": sha256_file(ontology_path),
        "nodes": nodes,
        "counts": {
            "source_rows": len(source_rows),
            "filed_forecast_nodes": 0,
            "model_demand_concepts": len(metric_ids),
            "model_demand_nodes": len(nodes),
            "material_model_demand_nodes": len(nodes),
        },
    }
    return {**body, "graph_sha256": sha256_value(body)}


def broker_declaration_with_model_context(
    *,
    spec: dict[str, Any],
    spec_path: Path,
    output_root: Path,
    filings_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Bind the optional broker lane to the canonical model-owned demand graph.

    Existing content-addressed v1 requests remain resumable. New controller work
    emits v2 demand only after mandatory filings topology has resolved, so
    derived/synthetic Tier-1 concepts are not lost merely because no literal
    filing row bears the canonical name.
    """
    declaration = json.loads(json.dumps(spec.get("broker") or {}))
    request_path = resolve(spec_path.parent, declaration.get("request_path"))
    if not request_path or not request_path.is_file():
        return declaration
    request = read_json(request_path, "broker request")
    existing_graph = (request.get("model_context") or {}).get("model_demand_graph")
    if isinstance(existing_graph, dict) and existing_graph.get("schema_version") in {"pre-broker-model-demand/1.0", "pre-broker-model-demand/2.0"}:
        demand_path = output_root / "internal-requests" / "pre-broker-model-demand.json"
        atomic_json(demand_path, existing_graph)
        derived_path = output_root / "internal-requests" / "broker-extraction-request.json"
        atomic_json(derived_path, request)
        declaration["request_path"] = str(derived_path)
        declaration["model_demand_path"] = str(demand_path)
        return declaration
    ingress_path = resolve(spec_path.parent, spec.get("attachment_ingress_path"))
    if not ingress_path or not ingress_path.is_file():
        return declaration
    ingress = read_json(ingress_path, "attachment-ingress template")
    evidence_path = resolve(ingress_path.parent, ingress.get("evidence_run_path"))
    if not evidence_path or not evidence_path.is_file():
        return declaration
    evidence = read_json(evidence_path, "base evidence-run template")
    filings = evidence.get("filings") or {}
    if isinstance(filings_state, dict):
        bundle_path = Path(str((filings_state.get("artifacts") or {}).get("filings_bundle") or ""))
        if bundle_path.is_file():
            bundle = read_json(bundle_path, "filings evidence bundle for broker model context")
            filings = bundle.get("filings") or filings
    try:
        demand_graph = _model_owned_broker_demand(request=request, spec=spec, filings=filings)
    except ValueError:
        return declaration
    request["model_context"] = {
        "as_of": demand_graph["as_of"],
        "reporting_currency": demand_graph["reporting_currency"],
        "units": demand_graph["units"],
        "forecast_periods": demand_graph["forecast_periods"],
        "model_demand_graph": demand_graph,
    }
    demand_path = output_root / "internal-requests" / "pre-broker-model-demand.json"
    atomic_json(demand_path, demand_graph)
    derived_path = output_root / "internal-requests" / "broker-extraction-request.json"
    atomic_json(derived_path, request)
    declaration["request_path"] = str(derived_path)
    declaration["model_demand_path"] = str(demand_path)
    return declaration

def ingress_lane_declarations(lanes: dict[str, dict[str, Any]], state_paths: dict[str, Path]) -> dict[str, Any]:
    declarations: dict[str, Any] = {}
    broker = lanes.get("broker")
    if broker and not (broker.get("summary") or {}).get("fault_contained_to_zero_authority"):
        artifacts = broker.get("artifacts", {})
        extraction = artifacts.get("verified_bundle") or artifacts.get("extraction_bundle")
        declarations["broker_evidence"] = {
            "run_state_path": str(state_paths["broker"]),
            "extraction_bundle_path": extraction,
            "source_tables_path": artifacts.get("source_tables") or artifacts.get("broker_source_tables"),
            "crosswalk_path": artifacts.get("crosswalk"),
            "crosswalk_receipt_path": artifacts.get("broker_crosswalk_receipt"),
            "semantic_verification_path": artifacts.get("semantic_report") or artifacts.get("broker_semantic_verification"),
        }
    dcs = lanes.get("dcs")
    if dcs:
        artifacts = dcs.get("artifacts", {})
        declarations["dcs_evidence"] = {
            "run_state_path": str(state_paths["dcs"]),
            "source_tables_path": artifacts.get("source_tables"),
            "candidate_manifest_path": artifacts.get("candidate_manifest"),
            "crosswalk_path": artifacts.get("crosswalk"),
            "projection_path": artifacts.get("projection"),
            "evidence_receipt_path": artifacts.get("compiler_receipt"),
            "independent_verification_path": artifacts.get("independent_verification"),
        }
    for lane, declaration in declarations.items():
        missing = sorted(field for field, value in declaration.items() if not value)
        if missing:
            raise ValueError(f"PASS {lane} state omits owned artifacts: {', '.join(missing)}")
    return declarations


def contain_optional_broker_failure(
    *,
    lane: dict[str, Any],
    spec: dict[str, Any],
    spec_path: Path,
    output_root: Path,
    reason_code: str = "broker_optional_close_failure",
) -> dict[str, Any]:
    """Close an internally failed broker adapter without consuming a value.

    This boundary deliberately does not attempt to manufacture the broker
    compiler's downstream receipts.  Those receipts prove selected authority;
    a fault-contained lane selects nothing.  The raw uploads are instead
    sealed directly and the attachment compiler archives them as rejected
    model sources.
    """
    assert_broker_failure_degrades(reason_code)
    broker = spec.get("broker") or {}
    request_path = resolve(spec_path.parent, broker.get("request_path"))
    documents: list[dict[str, Any]] = []
    if request_path and request_path.is_file():
        request = read_json(request_path, "fault-contained broker request")
        for document in request.get("documents") or []:
            source_path = resolve(request_path.parent, document.get("path"))
            if source_path and source_path.is_file():
                documents.append({
                    "document_id": str(document.get("document_id") or ""),
                    "file_name": source_path.name,
                    "byte_length": source_path.stat().st_size,
                    "raw_sha256": sha256_file(source_path),
                })
    documents.sort(key=lambda item: item["document_id"])
    original_summary = lane.get("summary") or {}
    receipt = {
        "schema_version": "broker-archive-only-receipt/1.0",
        "status": "PASS",
        "run_id": str(spec.get("run_id") or ""),
        "model_authority": "zero",
        "delivery_owner": "DEGRADE",
        "source_document_count": len(documents),
        "documents": documents,
        "contained_pipeline_status": lane.get("pipeline_status"),
        "contained_terminal_reason": original_summary.get("terminal_reason"),
        "reason_code": reason_code,
        "reason": (
            "The optional broker adapter did not close. Raw reports remain "
            "hash-archived and every broker authority edge is removed."
        ),
    }
    receipt["receipt_sha256"] = sha256_value(receipt)
    receipt_path = output_root / "broker" / "broker-archive-only-receipt.json"
    atomic_json(receipt_path, receipt)
    return {
        "schema_version": "broker-run-state/1.0",
        "run_id": str(spec.get("run_id") or ""),
        "pipeline_status": "PASS_DEGRADED",
        "user_blocking": False,
        "blocker_class": None,
        "tasks": [],
        "artifacts": {"broker_archive_only_receipt": str(receipt_path)},
        "artifact_sha256": {
            "broker_archive_only_receipt": sha256_file(receipt_path),
        },
        "checkpoints": [
            {
                "stage": "optional_broker_fault_containment",
                "status": "PASS",
                "output_sha256": sha256_file(receipt_path),
            }
        ],
        "fixed_point": {
            "status": "CLOSED",
            "remaining_task_count": 0,
        },
        "summary": {
            "degraded": True,
            "fault_contained_to_zero_authority": True,
            "quarantined_surface_count": 0,
            "source_document_count": len(documents),
            "contained_pipeline_status": lane.get("pipeline_status"),
            "contained_terminal_reason": original_summary.get("terminal_reason"),
        },
    }


def apply_broker_archive_only(
    *,
    resolved_ingress: dict[str, Any],
    ingress_base: Path,
    output_root: Path,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Remove broker authority while retaining raw files and visible PDF pages."""
    evidence_path = resolve(ingress_base, resolved_ingress.get("evidence_run_path"))
    if not evidence_path or not evidence_path.is_file():
        raise FileNotFoundError("Attachment-ingress template evidence_run_path is absent")
    evidence = read_json(evidence_path, "broker fault-containment evidence template")
    broker_source_ids = {
        str(source.get("source_id") or "")
        for source in evidence.get("source_inventory") or []
        if source.get("kind") == "user_broker_research"
    }
    source_by_id = {
        str(source.get("source_id") or ""): source
        for source in evidence.get("source_inventory") or []
    }
    for source in evidence.get("source_inventory") or []:
        if source.get("source_id") in broker_source_ids:
            source["status"] = "evidence_only"
            source["status_reason"] = (
                "Optional broker adapter failed internally; raw bytes are archived "
                "but the source is prohibited from model use."
            )
    evidence["retrieval_log"] = [
        item for item in evidence.get("retrieval_log") or []
        if item.get("selected_source_id") not in broker_source_ids
    ]
    for field in (
        "broker_source_tables",
        "broker_crosswalk_receipt",
        "broker_semantic_verification",
    ):
        evidence.pop(field, None)
    zero_pack = apply_zero_broker_authority(
        evidence,
        source_label="Forecast Waterfall — zero broker authority",
        notes=(
            "Optional broker processing failed internally. Raw reports remain archived, "
            "all broker observations are prohibited from model use, and the company "
            "forecast continues through the ordinary authority waterfall."
        ),
    )

    raw_documents: list[dict[str, Any]] = []
    page_evidence: list[dict[str, Any]] = []
    archive_root = output_root / "broker" / "archive-pages"
    for index, descriptor in enumerate(resolved_ingress.get("attachments") or [], start=1):
        if (descriptor.get("adapter") or {}).get("domain") != "broker_pack":
            continue
        raw_path = resolve(ingress_base, descriptor.get("path"))
        if not raw_path or not raw_path.is_file():
            continue
        source_ids = [str(value) for value in descriptor.get("source_ids") or []]
        source_id = source_ids[0] if source_ids else f"broker_archive_{index}"
        source = source_by_id.get(source_id) or {}
        content_sha256 = sha256_file(raw_path)
        house_name = str(source.get("name") or raw_path.stem).strip() or f"Broker {index}"
        house_id = re.sub(r"[^a-z0-9_]+", "_", source_id.lower()).strip("_") or f"broker_{index}"
        raw_documents.append({
            "attachment_id": str(descriptor.get("attachment_id") or f"broker-{index}"),
            "house_id": house_id,
            "house_name": house_name,
            "source_id": source_id,
            "file_name": raw_path.name,
            "byte_length": raw_path.stat().st_size,
            "content_sha256": content_sha256,
        })
        media_type = str(descriptor.get("media_type") or "").lower()
        if media_type != "application/pdf" and raw_path.suffix.lower() != ".pdf":
            continue
        try:
            house_root = archive_root / f"{index:02d}-{house_id}"
            pages = archive_pdf_pages(raw_path, house_root, source_id=source_id)
            if pages:
                page_house = {
                    "house_id": house_id,
                    "house_name": house_name,
                    "source_id": source_id,
                    "content_sha256": content_sha256,
                    "file_name": raw_path.name,
                    "pages": pages,
                }
                publication_date = source.get("publication_date")
                if isinstance(publication_date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", publication_date):
                    page_house["published_date"] = publication_date
                page_evidence.append(page_house)
        except Exception:
            # Raw custody is mandatory; page rendering is best-effort for an
            # unreadable/corrupt optional document and must not become a model
            # delivery gate.
            continue

    lanes = (evidence.get("case_evidence") or {}).get("lanes")
    if isinstance(lanes, dict):
        lanes["broker_archive"] = {
            "schema_version": "broker-archive/1.0",
            "raw_documents": raw_documents,
            **({"page_evidence": page_evidence} if page_evidence else {}),
        }
    ledger = evidence.get("forecast_observation_ledger")
    if isinstance(ledger, dict) and isinstance(ledger.get("observations"), list):
        ledger["observations"] = [
            item for item in ledger["observations"]
            if item.get("source_id") not in broker_source_ids
        ]
        if not ledger["observations"]:
            evidence.pop("forecast_observation_ledger", None)
            evidence.pop("forecast_observation_ledger_receipt", None)
    resolved_path = output_root / "broker-archive-only-evidence-template.json"
    atomic_json(resolved_path, evidence)
    resolved_ingress["evidence_run_path"] = str(resolved_path)
    resolved_ingress.pop("broker_evidence", None)
    return resolved_ingress, {"broker_archive_only_evidence": str(resolved_path)}


def apply_filings_lane(
    *,
    resolved_ingress: dict[str, Any],
    ingress_base: Path,
    filings_state: dict[str, Any],
    output_root: Path,
) -> tuple[dict[str, Any], dict[str, str]]:
    artifacts = filings_state.get("artifacts", {})
    bundle_path = Path(str(artifacts.get("filings_bundle") or ""))
    registry_path = Path(str(artifacts.get("document_extraction_registry") or ""))
    if not bundle_path.is_file() or not registry_path.is_file():
        raise ValueError("PASS filings lane omits its bundle or extraction registry")
    bundle = read_json(bundle_path, "filings evidence bundle")
    registry = read_json(registry_path, "document extraction registry")
    acquisition_registry_path = Path(str(artifacts.get("filings_source_registry") or ""))
    acquisition_registry = (
        read_json(acquisition_registry_path, "filings source registry")
        if acquisition_registry_path.is_file()
        else None
    )
    if acquisition_registry is not None:
        if acquisition_registry.get("schema_version") not in {"filings-source-registry/1.0", "filings-source-registry/2.0"}:
            raise ValueError("Filings source registry has the wrong schema version")
        registry_body = {
            key: value for key, value in acquisition_registry.items()
            if key != "registry_sha256"
        }
        if acquisition_registry.get("registry_sha256") != sha256_value(registry_body):
            raise ValueError("Filings source registry hash does not bind its complete payload")
    if bundle.get("schema_version") != "filings-evidence-bundle/1.0":
        raise ValueError("Filings bundle has the wrong schema version")
    calculated_bundle_hash = sha256_value({
        key: value for key, value in bundle.items() if key != "bundle_sha256"
    })
    if bundle.get("bundle_sha256") != calculated_bundle_hash:
        raise ValueError("Filings bundle hash does not bind its complete payload")
    evidence_path = resolve(ingress_base, resolved_ingress.get("evidence_run_path"))
    if not evidence_path or not evidence_path.is_file():
        raise FileNotFoundError("Attachment-ingress template evidence_run_path is absent")
    evidence = read_json(evidence_path, "base evidence-run template")
    if evidence.get("mode") == "first_run" and "model_case" in evidence:
        raise ValueError("A first-run evidence template may not carry caller-authored model_case")
    evidence["filings"] = bundle.get("filings")
    case_evidence = evidence.setdefault("case_evidence", {})
    case_evidence["face_statement_manifests"] = bundle.get("filings", {}).get(
        "face_statement_manifests", {}
    )
    case_evidence["filing_provenance"] = {
        "documents": bundle.get("documents", []),
        "period_authority": bundle.get("filings", {}).get("period_authority", {}),
    }
    evidence["case_source"] = {}
    evidence.pop("model_case", None)
    resolved_evidence_path = output_root / "resolved-evidence-template.json"
    atomic_json(resolved_evidence_path, evidence)
    resolved_ingress["evidence_run_path"] = str(resolved_evidence_path)
    registry_documents = registry.get("documents", {})
    used: set[str] = set()
    for descriptor in resolved_ingress.get("attachments", []):
        if descriptor.get("adapter", {}).get("domain") != "document_extraction":
            continue
        attachment_id = str(descriptor.get("attachment_id") or "")
        registry_entry = registry_documents.get(attachment_id)
        if not isinstance(registry_entry, dict):
            # document_extraction is also the lossless raw-input adapter for
            # policy answers and other non-filing company evidence. Only
            # attachments actually owned by the filings registry are replaced
            # here; every other explicit extraction remains bound and is
            # validated later by attachment ingress.
            explicit_path = resolve(
                ingress_base,
                descriptor.get("adapter", {}).get("extraction_path"),
            )
            if not explicit_path or not explicit_path.is_file():
                raise ValueError(
                    f"Non-filing document attachment {attachment_id} has no explicit extraction"
                )
            continue
        if acquisition_registry is not None:
            source_entry = acquisition_registry.get("documents", {}).get(attachment_id)
            if not isinstance(source_entry, dict):
                raise ValueError(f"Filings acquisition registry has no source for attachment {attachment_id}")
            acquired_path = Path(str(source_entry.get("path") or ""))
            if not acquired_path.is_file():
                raise ValueError(f"Acquired filing object is absent for attachment {attachment_id}")
            if sha256_file(acquired_path) != source_entry.get("raw_sha256"):
                raise ValueError(f"Acquired filing object hash does not match for attachment {attachment_id}")
            descriptor["path"] = str(acquired_path)
        extraction_path = Path(str((registry_entry or {}).get("path") or ""))
        if not extraction_path.is_file():
            raise ValueError(f"Filings lane has no extraction for attachment {attachment_id}")
        if sha256_file(extraction_path) != registry_entry.get("sha256"):
            raise ValueError(f"Filings extraction hash does not match for attachment {attachment_id}")
        descriptor["adapter"]["extraction_path"] = str(extraction_path)
        used.add(attachment_id)
    unused = sorted(set(registry_documents) - used)
    if unused:
        raise ValueError(f"Filings registry contains unbound attachment(s): {', '.join(unused)}")
    returned_artifacts = {
        "filings_bundle": str(bundle_path),
        "document_extraction_registry": str(registry_path),
        "resolved_evidence_template": str(resolved_evidence_path),
    }
    if acquisition_registry_path.is_file():
        returned_artifacts["filings_source_registry"] = str(acquisition_registry_path)
    return resolved_ingress, returned_artifacts


def apply_explicit_broker_skip(
    *,
    resolved_ingress: dict[str, Any],
    ingress_base: Path,
    output_root: Path,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Project a sealed user skip into the lawful zero-authority broker shape.

    This is controller output, not a caller-authored normalized broker pack.
    It exists because broker absence is a decision state while evidence-run and
    model-case schemas still require an explicit broker lane.
    """
    evidence_path = resolve(ingress_base, resolved_ingress.get("evidence_run_path"))
    if not evidence_path or not evidence_path.is_file():
        raise FileNotFoundError("Explicit broker skip has no evidence template")
    evidence = read_json(evidence_path, "explicit-skip evidence template")
    filings = evidence.get("filings") or {}
    forecast_periods = list(filings.get("forecast_periods") or [])
    if len(forecast_periods) != 3:
        raise ValueError("Explicit broker skip requires three filings-derived forecast periods")
    apply_zero_broker_authority(
        evidence,
        source_label="Broker research explicitly skipped",
        notes="Sealed upload-or-skip receipt selected zero broker authority.",
    )
    resolved_path = output_root / "explicit-skip-evidence-template.json"
    atomic_json(resolved_path, evidence)
    resolved_ingress["evidence_run_path"] = str(resolved_path)
    return resolved_ingress, {"explicit_broker_skip_projection": str(resolved_path)}


def apply_closed_broker_lane(
    *,
    resolved_ingress: dict[str, Any],
    ingress_base: Path,
    broker_state: dict[str, Any],
    output_root: Path,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Bind a closed broker lane to ingress without making raw custody semantic.

    The broker controller, not the caller's attachment descriptor, owns the
    compiled pack.  A selected-authority pack is therefore installed as the
    normalized artifact for the raw broker attachment.  A lawful degraded
    close whose pack selects no values keeps the raw files and controller
    receipts, but marks those sources evidence-only so attachment ingress does
    not demand a semantic-pack path from an archive-only file.
    """
    artifacts = broker_state.get("artifacts") or {}
    hashes = broker_state.get("artifact_sha256") or {}
    pack_path = Path(str(artifacts.get("broker_pack") or "")).resolve()
    if not pack_path.is_file():
        raise FileNotFoundError("Closed broker lane has no controller-owned broker pack")
    if hashes.get("broker_pack") != sha256_file(pack_path):
        raise ValueError("Closed broker lane has a stale broker-pack hash")
    pack = read_json(pack_path, "closed broker lane pack")

    evidence_path = resolve(ingress_base, resolved_ingress.get("evidence_run_path"))
    if not evidence_path or not evidence_path.is_file():
        raise FileNotFoundError("Closed broker lane has no evidence template")
    evidence = read_json(evidence_path, "closed-broker evidence template")
    evidence["broker_pack"] = pack
    selected_value_count = broker_pack_selected_value_count(pack)
    archive_only = selected_value_count == 0

    broker_source_ids = {
        str(source_id)
        for descriptor in resolved_ingress.get("attachments", [])
        if (descriptor.get("adapter") or {}).get("domain") == "broker_pack"
        for source_id in descriptor.get("source_ids") or []
    }
    if archive_only:
        for source in evidence.get("source_inventory") or []:
            if str(source.get("source_id")) in broker_source_ids:
                source["status"] = "evidence_only"
    else:
        for descriptor in resolved_ingress.get("attachments", []):
            adapter = descriptor.get("adapter") or {}
            if adapter.get("domain") == "broker_pack":
                adapter["normalized_path"] = str(pack_path)

    resolved_path = output_root / "closed-broker-evidence-template.json"
    atomic_json(resolved_path, evidence)
    resolved_ingress["evidence_run_path"] = str(resolved_path)
    return resolved_ingress, {
        "closed_broker_pack_projection": str(resolved_path),
        "closed_broker_pack": str(pack_path),
    }


CLOSED_LANE_STATUSES = {"PASS", "PASS_DEGRADED"}


def classify(lanes: dict[str, dict[str, Any]]) -> tuple[str, str | None, bool]:
    # PASS_DEGRADED is a CLOSED broker lane: evidence preserved, irreconcilable
    # regions quarantined model_use=prohibited. The delivery constitution makes
    # broker uncertainty a degradation domain, never a delivery blocker.
    blockers = [
        state.get("blocker_class")
        for state in lanes.values()
        if state.get("pipeline_status") not in CLOSED_LANE_STATUSES
    ]
    if not blockers:
        return "PASS", None, False
    if any(blocker in USER_BLOCKERS for blocker in blockers):
        selected = next(blocker for blocker in blockers if blocker in USER_BLOCKERS)
        return "BLOCKED_INPUT", selected, True
    if any(state.get("pipeline_status") == "BLOCKED_INTERNAL" for state in lanes.values()):
        return "BLOCKED_INTERNAL", "INTERNAL_WORK", False
    return "NEEDS_INTERNAL_WORK", "INTERNAL_WORK", False


def task_frontier(
    lanes: dict[str, dict[str, Any]],
    *,
    status: str,
    transaction_hash: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Project one typed task frontier without leaking internal work as a user ask."""
    lane_progress = {
        kind: {
            "pipeline_status": state.get("pipeline_status"),
            "blocker_class": state.get("blocker_class"),
            "user_blocking": state.get("user_blocking"),
            "progress_sha256": state.get("fixed_point", {}).get("progress_sha256"),
            "fixed_point_status": state.get("fixed_point", {}).get("status"),
        }
        for kind, state in sorted(lanes.items())
    }
    progress_sha = sha256_value({
        "transaction": transaction_hash,
        "lane_progress": lane_progress,
    })
    if status == "PASS":
        return [], {
            "schema_version": "attachment-internal-fixed-point/1.0",
            "status": "CLOSED",
            "progress_sha256": progress_sha,
            "lane_progress": lane_progress,
            "remaining_task_count": 0,
            "aggregate_terminal_defect_count": 0,
        }
    if status == "BLOCKED_INPUT":
        tasks = [
            {"lane": kind, **task}
            for kind, state in lanes.items()
            if state.get("user_blocking") is True
            for task in state.get("tasks", [])
        ]
        return tasks, {
            "schema_version": "attachment-internal-fixed-point/1.0",
            "status": "USER_BOUNDARY",
            "progress_sha256": progress_sha,
            "lane_progress": lane_progress,
            "remaining_task_count": len(tasks),
            "aggregate_terminal_defect_count": 0,
        }

    internal_tasks = [
        {"lane": kind, **task}
        for kind, state in lanes.items()
        if state.get("user_blocking") is False
        for task in state.get("tasks", [])
    ]
    if status != "BLOCKED_INTERNAL":
        return internal_tasks, {
            "schema_version": "attachment-internal-fixed-point/1.0",
            "status": "OPEN",
            "progress_sha256": progress_sha,
            "lane_progress": lane_progress,
            "remaining_task_count": len(internal_tasks),
            "aggregate_terminal_defect_count": 0,
        }

    underlying = [
        {
            "lane": task.get("lane"),
            "task_id": task.get("task_id"),
            "task_kind": task.get("task_kind"),
            "terminal_reasons": task.get("terminal_reasons", []),
        }
        for task in internal_tasks
    ]
    task_input_sha = sha256_value({
        "transaction": transaction_hash,
        "underlying": underlying,
        "lane_progress": lane_progress,
    })
    aggregate = {
        "lane": "attachment",
        "task_kind": "internal_fixed_point_defect",
        "task_id": f"attachment-task-{task_input_sha[:24]}",
        "user_blocking": False,
        "underlying_lane_defects": underlying,
        "remedy": {
            "remedy_id": "repair_earliest_lane_or_response_boundary",
            "deterministic_steps": [
                "Inspect each hash-bound lane state named by this aggregate defect.",
                "Repair the earliest controller or model-host boundary that exhausted or regressed.",
                "Do not alter source evidence, schemas or validators to clear the defect.",
                "Resume the same attachment transaction and require unchanged checkpoints to be reused."
            ],
            "resume_protocol": {
                "controller": "scripts/run_attachment_evidence_pipeline.py",
                "same_transaction_required": True,
                "reuse_valid_checkpoints": True,
            },
        },
        "attempt_budget": {
            "attempts_used": 0,
            "attempt_limit": 1,
            "attempts_remaining": 1,
        },
        "progress_measure": {
            "progress_sha256": progress_sha,
            "task_input_sha256": task_input_sha,
            "lane_count": len(lanes),
            "underlying_defect_count": len(underlying),
        },
        "model_host_response_boundary": {
            "producer_kind": "controller_maintainer",
            "expected_response_files": [],
            "source_and_validator_mutation_forbidden": True,
            "python_may_not_author_visual_or_semantic_response": True,
        },
    }
    return [aggregate], {
        "schema_version": "attachment-internal-fixed-point/1.0",
        "status": "TERMINAL_DEFECT",
        "progress_sha256": progress_sha,
        "lane_progress": lane_progress,
        "remaining_task_count": 1,
        "aggregate_terminal_defect_count": 1,
    }


def write_state(
    target: Path, *, spec: dict[str, Any], spec_hash: str, runtime_hash: str,
    status: str, blocker: str | None, user_blocking: bool,
    lanes: dict[str, dict[str, Any]], checkpoints: list[dict[str, Any]],
    artifacts: dict[str, str], tasks: list[dict[str, Any]], summary: dict[str, Any],
) -> None:
    assert_state("attachment", status, blocker, user_blocking)
    transaction_hash = sha256_value({
        "spec": spec_hash,
        "runtime": runtime_hash,
        "lanes": {
            kind: state.get("cache_key") or state.get("source_sha256") or state.get("request_sha256")
            for kind, state in sorted(lanes.items())
        },
    })
    prior: dict[str, Any] = {}
    if target.is_file():
        try:
            prior = read_json(target, "prior attachment evidence run state")
        except ValueError:
            prior = {}
    assert_transition(
        "attachment",
        prior.get("pipeline_status"),
        status,
        reset=prior.get("workflow_transaction_sha256") != transaction_hash,
    )
    projected_tasks, fixed_point = task_frontier(
        lanes,
        status=status,
        transaction_hash=transaction_hash,
    )
    # The caller passes lane tasks for compatibility, but typed ownership and
    # aggregation are authoritative here. This prevents an internal lane packet
    # from appearing beside a genuine user-owned evidence request.
    tasks = projected_tasks
    value = {
        "schema_version": "attachment-evidence-run-state/1.0",
        "run_id": spec["run_id"],
        "pipeline_status": status,
        "user_blocking": user_blocking,
        "blocker_class": blocker,
        "controller_spec_sha256": spec_hash,
        "runtime_closure_sha256": runtime_hash,
        "workflow_transaction_sha256": transaction_hash,
        "lane_states": lanes,
        "checkpoints": checkpoints,
        "artifacts": artifacts,
        "artifact_sha256": {
            name: sha256_file(Path(path))
            for name, path in sorted(artifacts.items())
            if Path(path).is_file()
        },
        "tasks": tasks,
        "fixed_point": fixed_point,
        "summary": summary,
    }
    atomic_json(target, value)
    print(json.dumps({
        "status": status, "blocker_class": blocker, "user_blocking": user_blocking,
        "task_count": len(tasks), "state": str(target), **summary,
    }, sort_keys=True))



_TELEMETRY_STARTED_AT = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
_TELEMETRY_STARTED_MONOTONIC = time.monotonic()
atexit.register(lambda: _write_process_telemetry("FAIL" if getattr(sys, "last_value", None) else "PASS"))

def _write_process_telemetry(status: str) -> None:
    directory = os.environ.get("EXCEL_INFLOW_TELEMETRY_DIR")
    if not directory:
        return
    try:
        import hashlib
        import datetime as dt
        target_dir = Path(directory).resolve(); target_dir.mkdir(parents=True, exist_ok=True)
        ended_at = dt.datetime.now(dt.timezone.utc).isoformat()
        trace = {
            "schema_version": "excel-inflow-run-telemetry/1.0",
            "trace_id": os.environ.get("EXCEL_INFLOW_TRACE_ID") or f"trace.python.{os.getpid()}",
            "run_id": os.environ.get("EXCEL_INFLOW_RUN_ID"),
            "component": "attachment_evidence_pipeline",
            "process_id": os.getpid(),
            "parent_span_id": os.environ.get("EXCEL_INFLOW_PARENT_SPAN_ID"),
            "user_submitted_at": os.environ.get("EXCEL_INFLOW_USER_SUBMITTED_AT") or _TELEMETRY_STARTED_AT,
            "process_started_at": _TELEMETRY_STARTED_AT,
            "process_ended_at": ended_at,
            "visible_response_at": None,
            "source_identity": None,
            "spans": [{
                "span_id": f"span.python.{os.getpid()}", "parent_span_id": os.environ.get("EXCEL_INFLOW_PARENT_SPAN_ID"),
                "name": "process", "kind": "process", "owner": "attachment_evidence_pipeline",
                "started_at": _TELEMETRY_STARTED_AT, "ended_at": ended_at,
                "duration_ms": max(0, round((time.monotonic() - _TELEMETRY_STARTED_MONOTONIC) * 1000)),
                "status": "OK" if status == "PASS" else "ERROR", "attributes": {},
            }],
            "events": [], "status": status,
            "process_duration_ms": max(0, round((time.monotonic() - _TELEMETRY_STARTED_MONOTONIC) * 1000)),
            "user_visible_duration_ms": None,
        }
        body = json.dumps(trace, sort_keys=True, separators=(",", ":")) + "\n"
        trace["telemetry_sha256"] = hashlib.sha256(body.encode("utf8")).hexdigest()
        target = target_dir / f"attachment_evidence_pipeline-{os.getpid()}.json"
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(json.dumps(trace, indent=2, sort_keys=True) + "\n", "utf8")
        temporary.replace(target)
    except Exception:
        pass

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec")
    parser.add_argument("--out", required=True)
    parser.add_argument("--force-zero-broker", action="store_true")
    args = parser.parse_args()
    spec_path = Path(args.spec).resolve()
    output_root = Path(args.out).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    state_path = output_root / "attachment-evidence-run-state.json"
    spec = read_json(spec_path, "attachment evidence controller spec")
    experience_trace = ExperienceTrace(run_id=str(spec.get("run_id") or output_root.name), scope="attachment_evidence_controller")
    experience_span = experience_trace.span("attachment_evidence_pipeline", "run_attachment_evidence_pipeline", "excel_inflow_active", metadata={"coverage_role": "root"})
    experience_span.__enter__()
    def _finish_experience_trace() -> None:
        try:
            experience_span.__exit__(None, None, None)
        finally:
            write_trace(output_root / "experience-trace.json", experience_trace.finish())
    atexit.register(_finish_experience_trace)
    if spec.get("schema_version") != "attachment-evidence-controller/1.0":
        raise ValueError("Attachment evidence controller spec has the wrong schema version")
    if (
        not spec.get("run_id")
        or not spec.get("attachment_ingress_path")
        or not spec.get("case_source_declarations_path")
        or not spec.get("broker_intake_choice_path")
    ):
        raise ValueError(
            "Attachment evidence controller spec lacks run_id, attachment_ingress_path "
            "case_source_declarations_path or broker_intake_choice_path"
        )
    if not any(spec.get(lane) for lane in ("filings", "broker", "dcs")):
        raise ValueError("Attachment evidence controller spec declares no evidence lane")
    spec_hash = sha256_file(spec_path)
    runtime_hash = runtime_closure()
    broker_intake_choice, broker_intake_choice_path = verify_broker_intake_choice(
        spec, spec_path
    )
    # The upload-or-skip choice binds user intent, issuer identity, filing
    # context and exact attachment bytes.  A runtime upgrade must invalidate
    # derived broker work, but it must not erase that user decision or force a
    # re-upload.  Retain the original closure for audit and let the component
    # cache keys decide which descendants require recomputation.
    broker_choice_runtime_migrated = (
        broker_intake_choice.get("runtime_closure_sha256") != runtime_hash
    )
    lanes: dict[str, dict[str, Any]] = {}
    lane_duration_ms: dict[str, int] = {}
    state_paths: dict[str, Path] = {}
    checkpoints: list[dict[str, Any]] = []
    derived_artifacts: dict[str, str] = {
        "broker_intake_choice": str(broker_intake_choice_path),
    }
    if broker_choice_runtime_migrated:
        migration = {
            "schema_version": "broker-intake-runtime-migration/1.0",
            "status": "PASS",
            "run_id": spec.get("run_id"),
            "choice_receipt_sha256": broker_intake_choice.get("receipt_sha256"),
            "recorded_runtime_closure_sha256": broker_intake_choice.get(
                "runtime_closure_sha256"
            ),
            "current_runtime_closure_sha256": runtime_hash,
            "effect": "preserve_user_choice_recompute_derived_broker_work",
        }
        migration_path = output_root / "broker-intake-runtime-migration.json"
        atomic_json(migration_path, migration)
        derived_artifacts["broker_intake_runtime_migration"] = str(migration_path)
    def execute_lane(kind: str, declaration: dict[str, Any]) -> tuple[dict[str, Any], int]:
        started = time.monotonic()
        try:
            if kind == "broker" and args.force_zero_broker:
                raise RuntimeError(
                    "The top-level optional-broker circuit breaker requested zero authority"
                )
            state = run_lane(kind, declaration, spec_path.parent, output_root)
        except Exception as error:
            state = {
                "schema_version": f"{kind}-run-state/1.0",
                "pipeline_status": "BLOCKED_INTERNAL",
                "user_blocking": False,
                "blocker_class": "INTERNAL_WORK",
                "tasks": [],
                "artifacts": {},
                "artifact_sha256": {},
                "summary": {
                    "terminal_reason": f"{kind}_controller_exception",
                    "message": str(error),
                },
            }
        return state, round((time.monotonic() - started) * 1000)

    # Filings is the executable model-demand producer and therefore closes
    # first.  Once its period and row graph exists, optional broker work and
    # mandatory debt extraction are independent.  Run those two lanes
    # concurrently but publish their checkpoints in the visible journey order
    # Filings -> Brokers -> Debt.  This removes optional broker wall time from
    # the mandatory critical path without changing economic authority.
    if spec.get("filings"):
        lanes["filings"], lane_duration_ms["filings"] = execute_lane(
            "filings", spec["filings"]
        )

    concurrent_declarations: dict[str, dict[str, Any]] = {}
    if spec.get("broker"):
        broker_declaration = broker_declaration_with_model_context(
            spec=spec,
            spec_path=spec_path,
            output_root=output_root,
            filings_state=lanes.get("filings"),
        )
        if broker_declaration.get("model_demand_path"):
            derived_artifacts["pre_broker_model_demand"] = str(
                broker_declaration.pop("model_demand_path")
            )
        concurrent_declarations["broker"] = broker_declaration
    if spec.get("dcs"):
        concurrent_declarations["dcs"] = spec["dcs"]
    if concurrent_declarations:
        with ThreadPoolExecutor(max_workers=len(concurrent_declarations)) as executor:
            futures = {
                kind: executor.submit(execute_lane, kind, declaration)
                for kind, declaration in concurrent_declarations.items()
            }
            for kind in ("broker", "dcs"):
                if kind in futures:
                    lanes[kind], lane_duration_ms[kind] = futures[kind].result()

    for kind in ("filings", "broker", "dcs"):
        if kind not in lanes:
            continue
        if (
            kind == "broker"
            and lanes[kind].get("pipeline_status") not in CLOSED_LANE_STATUSES
            and lanes[kind].get("blocker_class") == "INTERNAL_WORK"
        ):
            # The broker lane is optional. Its own negative-only close is the
            # first remedy; if that controller boundary also fails, contain
            # the adapter here. This is the final architectural circuit
            # breaker: archive raw reports, select zero broker authority, and
            # keep the mandatory filings/debt transaction alive.
            lanes[kind] = contain_optional_broker_failure(
                lane=lanes[kind],
                spec=spec,
                spec_path=spec_path,
                output_root=output_root,
                reason_code=(
                    "broker_timeout"
                    if "timeout" in str(
                        (lanes[kind].get("summary") or {}).get("message") or ""
                    ).lower()
                    else "broker_controller_exception"
                    if (lanes[kind].get("summary") or {}).get("terminal_reason")
                    == "broker_controller_exception"
                    else "broker_invalid_state"
                    if (lanes[kind].get("summary") or {}).get("terminal_reason")
                    == "invalid_lane_state"
                    else "broker_optional_close_failure"
                ),
            )
            derived_artifacts["broker_archive_only_receipt"] = lanes[kind][
                "artifacts"
            ]["broker_archive_only_receipt"]
        state_paths[kind] = output_root / kind / f"{kind}-run-state.json"
        checkpoints.append({
            "stage": kind,
            "status": lanes[kind].get("pipeline_status"),
            "state_sha256": sha256_file(state_paths[kind]) if state_paths[kind].is_file() else None,
            "duration_ms": lane_duration_ms.get(kind),
        })
    status, blocker, user_blocking = classify(lanes)
    broker_lane = lanes.get("broker") or {}
    if broker_lane.get("pipeline_status") == "PASS_DEGRADED":
        broker_summary = broker_lane.get("summary") or {}
        degraded_receipt_raw = (broker_lane.get("artifacts") or {}).get(
            "degraded_close_receipt"
        )
        degraded_receipt_path = (
            Path(str(degraded_receipt_raw)) if degraded_receipt_raw else None
        )
        degraded_receipt_owned = bool(
            degraded_receipt_path
            and degraded_receipt_path.is_file()
            and (broker_lane.get("artifact_sha256") or {}).get(
                "degraded_close_receipt"
            ) == sha256_file(degraded_receipt_path)
        )
        archive_only_receipt_raw = (broker_lane.get("artifacts") or {}).get(
            "broker_archive_only_receipt"
        )
        archive_only_receipt_path = (
            Path(str(archive_only_receipt_raw)) if archive_only_receipt_raw else None
        )
        archive_only_owned = bool(
            archive_only_receipt_path
            and archive_only_receipt_path.is_file()
            and (broker_lane.get("artifact_sha256") or {}).get(
                "broker_archive_only_receipt"
            ) == sha256_file(archive_only_receipt_path)
        )
        quarantine_disclosed = bool(broker_summary.get("degraded")) and (
            "quarantined_conflict_count" in broker_summary
            or "quarantined_surface_count" in broker_summary
        ) and (
            degraded_receipt_owned
            or (
                broker_summary.get("fault_contained_to_zero_authority") is True
                and archive_only_owned
            )
        )
        if not quarantine_disclosed:
            # A degraded close without its quarantine receipt is an invalid
            # artifact closure, not an acceptable lane.
            broker_lane["pipeline_status"] = "BLOCKED_INTERNAL"
            broker_lane["blocker_class"] = "INTERNAL_WORK"
            broker_lane["user_blocking"] = False
            broker_lane.setdefault("summary", {})["terminal_reason"] = (
                "degraded_close_missing_quarantine_receipt"
            )
            status, blocker, user_blocking = classify(lanes)
    tasks = [
        {"lane": kind, **task}
        for kind, state in lanes.items()
        for task in state.get("tasks", [])
    ]
    if status != "PASS":
        write_state(
            state_path, spec=spec, spec_hash=spec_hash, runtime_hash=runtime_hash,
            status=status, blocker=blocker, user_blocking=user_blocking,
            lanes=lanes, checkpoints=checkpoints, artifacts={}, tasks=tasks,
            summary={
                "lane_statuses": {kind: state.get("pipeline_status") for kind, state in lanes.items()},
                "performance": {
                    "lane_duration_ms": lane_duration_ms,
                    "broker_and_debt_execution": "concurrent_after_filings",
                },
            },
        )
        return 2

    try:
        base_ingress_path = resolve(spec_path.parent, spec["attachment_ingress_path"])
        if not base_ingress_path or not base_ingress_path.is_file():
            raise FileNotFoundError("The internal attachment-ingress template is absent")
        resolved_ingress = read_json(base_ingress_path, "attachment-ingress template")
        filings_artifacts: dict[str, str] = {}
        if "filings" in lanes:
            resolved_ingress, filings_artifacts = apply_filings_lane(
                resolved_ingress=resolved_ingress,
                ingress_base=base_ingress_path.parent,
                filings_state=lanes["filings"],
                output_root=output_root,
            )
        else:
            base_evidence_path = resolve(
                base_ingress_path.parent,
                resolved_ingress.get("evidence_run_path"),
            )
            base_evidence = read_json(base_evidence_path, "base evidence-run template") if base_evidence_path else {}
            if base_evidence.get("mode") == "first_run" and any(
                descriptor.get("adapter", {}).get("domain") == "document_extraction"
                for descriptor in resolved_ingress.get("attachments", [])
            ):
                raise ValueError(
                    "First-run raw filing attachments require the controller-owned filings lane"
                )
        broker_skip_artifacts: dict[str, str] = {}
        if broker_intake_choice.get("intake_state") == "explicitly_skipped":
            resolved_ingress, broker_skip_artifacts = apply_explicit_broker_skip(
                resolved_ingress=resolved_ingress,
                ingress_base=base_ingress_path.parent,
                output_root=output_root,
            )
        broker_archive_artifacts: dict[str, str] = {}
        broker_lane_artifacts: dict[str, str] = {}
        if (
            "broker" in lanes
            and broker_intake_choice.get("intake_state") != "explicitly_skipped"
            and not (lanes.get("broker", {}).get("summary") or {}).get(
                "fault_contained_to_zero_authority"
            )
        ):
            resolved_ingress, broker_lane_artifacts = apply_closed_broker_lane(
                resolved_ingress=resolved_ingress,
                ingress_base=base_ingress_path.parent,
                broker_state=lanes["broker"],
                output_root=output_root,
            )
        if (lanes.get("broker", {}).get("summary") or {}).get(
            "fault_contained_to_zero_authority"
        ):
            resolved_ingress, broker_archive_artifacts = apply_broker_archive_only(
                resolved_ingress=resolved_ingress,
                ingress_base=base_ingress_path.parent,
                output_root=output_root,
            )
        resolved_ingress.update(ingress_lane_declarations(lanes, state_paths))
        resolved_path = output_root / "resolved-attachment-ingress.json"
        atomic_json(resolved_path, resolved_ingress)
        declarations_path = resolve(
            spec_path.parent,
            spec["case_source_declarations_path"],
        )
        if not declarations_path or not declarations_path.is_file():
            raise FileNotFoundError("The internal case-source declarations file is absent")
        compiled_root = output_root / "compiled-evidence"
        completed = run([
            "node", str(HERE / "compile_declared_evidence_run.mjs"), str(resolved_path),
            "--declarations", str(declarations_path), "--out", str(compiled_root),
        ])
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or completed.stdout).strip()[-4000:])
        artifacts = {
            "resolved_attachment_ingress": str(resolved_path),
            "case_source": str(compiled_root / "case-source.json"),
            "attachment_manifest": str(compiled_root / "attachment-manifest.json"),
            "evidence_run": str(compiled_root / "evidence-run.json"),
            "validation": str(compiled_root / "validation.json"),
            **derived_artifacts,
            **filings_artifacts,
            **broker_lane_artifacts,
            **broker_archive_artifacts,
            **broker_skip_artifacts,
        }
        checkpoints.append({
            "stage": "case_source_proposal",
            "status": "PASS",
            "state_sha256": sha256_file(Path(artifacts["case_source"])),
        })
        checkpoints.append({
            "stage": "attachment_ingress",
            "status": "PASS",
            "state_sha256": sha256_file(Path(artifacts["evidence_run"])),
        })
        write_state(
            state_path, spec=spec, spec_hash=spec_hash, runtime_hash=runtime_hash,
            status="PASS", blocker=None, user_blocking=False, lanes=lanes,
            checkpoints=checkpoints, artifacts=artifacts, tasks=[],
            summary={
                "lane_statuses": {
                    kind: state.get("pipeline_status") for kind, state in lanes.items()
                },
                "degraded_lanes": sorted(
                    kind for kind, state in lanes.items()
                    if state.get("pipeline_status") == "PASS_DEGRADED"
                ),
                "evidence_run_sha256": sha256_file(Path(artifacts["evidence_run"])),
                "performance": {
                    "lane_duration_ms": lane_duration_ms,
                    "broker_and_debt_execution": "concurrent_after_filings",
                },
            },
        )
        return 0
    except Exception as error:
        write_state(
            state_path, spec=spec, spec_hash=spec_hash, runtime_hash=runtime_hash,
            status="BLOCKED_INTERNAL", blocker="INTERNAL_WORK", user_blocking=False,
            lanes=lanes, checkpoints=checkpoints, artifacts={}, tasks=[],
            summary={"terminal_reason": "attachment_ingress_failed", "message": str(error)},
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
