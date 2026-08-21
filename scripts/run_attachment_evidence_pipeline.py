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
import resource
import shutil
import subprocess
import signal
import sys
import tempfile
import threading
import time
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


def resolve_node_executable() -> str:
    """Resolve one absolute Node executable for every Python-owned JS child.

    The top-level controller supplies EXCEL_INFLOW_NODE=process.execPath after
    the runtime doctor certifies it. Standalone development invocations resolve
    PATH once here, then retain that absolute custody; no lane launches a bare
    `node` that can drift between preflight and execution.
    """
    declared = os.environ.get("EXCEL_INFLOW_NODE")
    candidate = declared if declared else shutil.which("node")
    if not candidate:
        raise RuntimeError("No Node executable is under custody for the evidence controller")
    resolved = Path(candidate)
    if not resolved.is_absolute() or not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise RuntimeError("The evidence controller's Node executable is not one absolute executable file")
    return str(resolved)


NODE_EXECUTABLE = resolve_node_executable()


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


def sha256_node_value(value: Any) -> str:
    """Match scripts/lib/run_store.mjs hashValue (pretty canonical JSON, no LF)."""
    encoded = json.dumps(
        value,
        sort_keys=True,
        indent=2,
        ensure_ascii=False,
        separators=(",", ": "),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


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
    process = subprocess.Popen(
        command,
        cwd=HERE,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    except subprocess.TimeoutExpired as error:
        targeted = snapshot_process_tree(process.pid)
        signal_process_tree(targeted, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            targeted = sorted(set(targeted + snapshot_process_tree(process.pid)))
            signal_process_tree(targeted, signal.SIGKILL)
            stdout, stderr = process.communicate()
        deadline = time.monotonic() + 2
        survivors = [pid for pid in targeted if process_exists(pid)]
        while survivors and time.monotonic() < deadline:
            time.sleep(0.025)
            survivors = [pid for pid in targeted if process_exists(pid)]
        if survivors:
            raise RuntimeError(
                "controller timeout retained live descendant pids: "
                + ",".join(str(pid) for pid in survivors)
            )
        termination = {
            "schema_version": "process-tree-termination/1.0",
            "root_pid": process.pid,
            "targeted_pids": targeted,
            "survivor_pids": [],
            "verified": True,
        }
        termination["receipt_sha256"] = sha256_value(termination)
        def text(value: Any) -> str:
            return value.decode(errors="replace") if isinstance(value, bytes) else str(value or "")
        return subprocess.CompletedProcess(
            command,
            124,
            text(stdout or error.stdout),
            text(stderr or error.stderr)
            + f"\ncontroller timeout after {timeout_seconds} seconds; "
            + json.dumps(termination, sort_keys=True),
        )


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def snapshot_process_tree(root_pid: int) -> list[int]:
    completed = subprocess.run(
        ["ps", "-axo", "pid=,ppid="], text=True, capture_output=True, check=False
    )
    if completed.returncode != 0:
        return [root_pid]
    children: dict[int, list[int]] = {}
    for line in completed.stdout.splitlines():
        fields = line.split()
        if len(fields) != 2:
            continue
        pid, parent = map(int, fields)
        children.setdefault(parent, []).append(pid)
    result: list[int] = []
    pending = [root_pid]
    while pending:
        pid = pending.pop()
        if pid in result:
            continue
        result.append(pid)
        pending.extend(children.get(pid, []))
    return result


def signal_process_tree(pids: list[int], requested_signal: signal.Signals) -> None:
    for pid in reversed(pids):
        try:
            os.killpg(pid, requested_signal)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            os.kill(pid, requested_signal)
        except (ProcessLookupError, PermissionError):
            pass


def lane_timeout_budget(kind: str, request_path: Path) -> int:
    """Derive a finite lane budget from the source inventory, never one blob size."""
    request: dict[str, Any] = {}
    try:
        request = read_json(request_path, f"{kind} timeout request")
    except (OSError, ValueError):
        pass
    document_count = len(request.get("documents") or [])
    if kind == "broker":
        # Two minutes of native extraction per document plus one bounded
        # three-minute semantic frontier, capped by the twelve-minute optional
        # broker envelope.  A timeout is contained by the zero/partial-authority
        # circuit breaker below; it never becomes a re-upload request.
        return min(720, 180 + 120 * max(1, document_count))
    if kind == "filings":
        # Outer crash watchdog only. The filings controller independently owns
        # and receipts 120s acquisition and 480s extraction timers.
        return 630
    return 180


def lane_requires_execution(kind: str, reusable_mandatory_lanes: dict[str, dict[str, Any]]) -> bool:
    """Authoritative call-order gate for a zero-broker downstream resume."""
    return kind == "broker" or kind not in reusable_mandatory_lanes


# ---------------------------------------------------------------------------
# P6.5 — bounded parallelism, budget priority, per-lane resource receipts.
#
# The lane pool used to take its worker count straight from the number of
# concurrent declarations: as many workers as there happened to be lanes, with
# no cpu, memory or budget bound.
# Worker count now derives from DECLARED resource limits, following stage 4's
# `validator_concurrency` precedent (size the concurrency from a measured
# resource) rather than inventing a second convention.
#
# The remaining run budget is READ from P6.1's one persisted monotonic ledger
# and never written here: there is still exactly one clock and one writer.
# Absence of a ledger means the declared lane budgets apply unchanged.
# ---------------------------------------------------------------------------
LANE_RESOURCE_POLICY_PATH = ROOT / "assets" / "lane-resource-policy-v1.json"
PRODUCT_CONSTITUTION_PATH = ROOT / "assets" / "product-constitution-v1.json"
LANE_RESOURCE_POLICY_SCHEMA = "excel-inflow-lane-resource-policy/1.0"
LANE_RESOURCE_PLAN_SCHEMA = "lane-resource-plan/1.0"
LANE_RESOURCE_RECEIPT_SCHEMA = "lane-resource-receipt/1.0"
LANE_RESOURCE_RECEIPTS_SCHEMA = "lane-resource-receipts/1.0"
BROKER_WALL_BUDGET_SCHEMA = "broker-wall-budget/1.0"
BROKER_WALL_BUDGET_FILE = "broker-wall-budget.json"
BROKER_OPTIONAL_CLOSE_MAX_MS = 180_000
BROKER_MIN_EXECUTION_SLICE_MS = 1_000
# P6.1 owns this variable. This controller is a READER of that ledger.
RUN_DEADLINE_ENV_NAME = "EXCEL_INFLOW_RUN_DEADLINE"


def load_lane_resource_policy() -> dict[str, Any]:
    """The declared resource limits. A malformed policy is never used."""
    policy = read_json(LANE_RESOURCE_POLICY_PATH, "lane resource policy")
    if policy.get("schema_version") != LANE_RESOURCE_POLICY_SCHEMA:
        raise ValueError("Lane resource policy has the wrong schema version")
    for section in ("worker_reservation", "budget_priority"):
        if not isinstance(policy.get(section), dict):
            raise ValueError(f"Lane resource policy lacks a {section} declaration")
    tiers = policy.get("worker_tiers")
    if not isinstance(tiers, list) or not tiers:
        raise ValueError("Lane resource policy declares no worker tiers")
    return policy


def lane_criticalities() -> dict[str, str]:
    """Lane criticality is declared ONCE, in the product constitution."""
    constitution = read_json(PRODUCT_CONSTITUTION_PATH, "product constitution")
    lanes = constitution.get("evidence_lanes") or {}
    return {
        str(lane): str((declaration or {}).get("criticality") or "")
        for lane, declaration in lanes.items()
    }


def lane_priority_class(criticality: str, policy: dict[str, Any]) -> str:
    """Optional only when the constitution says so; never optional by default."""
    return "optional" if str(criticality) in (policy.get("optional_criticalities") or []) else "mandatory"


def host_resources(policy: dict[str, Any]) -> tuple[int, int]:
    """The measured host, with a declared fallback when it cannot be read."""
    try:
        cpu_count = int(os.cpu_count() or 1)
    except (TypeError, ValueError):
        cpu_count = 1
    total_memory_mib = 0
    try:
        total_memory_mib = int(
            (os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")) / (1024 * 1024)
        )
    except (AttributeError, ValueError, OSError):
        total_memory_mib = 0
    if total_memory_mib <= 0:
        total_memory_mib = int(policy.get("assumed_total_memory_mib") or 4096)
    return max(1, cpu_count), max(1, total_memory_mib)


def resolve_lane_worker_count(
    policy: dict[str, Any], lane_count: int, cpu_count: int, total_memory_mib: int
) -> int:
    """Worker count from the DECLARED limits. Lane count is the LAST bound."""
    lanes = int(lane_count)
    if lanes < 1:
        raise ValueError("A lane pool needs a positive lane count")
    reservation = policy["worker_reservation"]
    cpus = max(1, int(cpu_count or 1))
    memory_mib = int(total_memory_mib or 0) or int(policy["assumed_total_memory_mib"])
    usable_memory_mib = max(0, memory_mib - int(reservation["reserved_memory_mib"]))
    tier_workers = 1
    for tier in policy["worker_tiers"]:
        if usable_memory_mib >= int(tier["min_usable_memory_mib"]):
            tier_workers = int(tier["max_workers"])
    memory_workers = max(
        1, min(tier_workers, usable_memory_mib // int(reservation["memory_mib_per_worker"]))
    )
    cpu_workers = max(
        1, (cpus - int(reservation["reserved_cpu"])) // int(reservation["cpu_per_worker"])
    )
    return max(1, min(lanes, memory_workers, cpu_workers, int(policy["max_workers_ceiling"])))


def run_deadline_remaining_ms() -> int | None:
    """Remaining compute on P6.1's ONE persisted clock. Read-only, never written.

    Any unreadable, foreign or absent ledger yields None, which means the
    declared lane budgets apply unchanged — exactly the behaviour that shipped
    before this package.
    """
    ledger_path = os.environ.get(RUN_DEADLINE_ENV_NAME)
    if not ledger_path:
        return None
    try:
        ledger = read_json(Path(ledger_path), "run deadline ledger")
    except (OSError, ValueError):
        return None
    if not str(ledger.get("schema_version") or "").startswith("excel-inflow-run-deadline/"):
        return None
    try:
        ceiling = int(ledger["hard_deadline_compute_ms"])
        elapsed = int(ledger.get("compute_elapsed_ms") or 0)
    except (KeyError, TypeError, ValueError):
        return None
    return max(0, ceiling - elapsed)


def lane_budget_caps(policy: dict[str, Any], remaining_compute_ms: int | None) -> dict[str, Any]:
    """The two caps this pool draws on: mandatory first, optional on the surplus."""
    priority = policy["budget_priority"]
    remaining = None
    if remaining_compute_ms is not None:
        try:
            remaining = max(0, int(remaining_compute_ms))
        except (TypeError, ValueError):
            remaining = None
    if remaining is None:
        return {
            "budget_source": "declared_only",
            "remaining_compute_ms": None,
            "mandatory_reserve_ms": int(priority["mandatory_reserve_ms"]),
            "mandatory_cap_ms": None,
            "optional_cap_ms": None,
        }
    return {
        "budget_source": "run_deadline_ledger",
        "remaining_compute_ms": remaining,
        "mandatory_reserve_ms": int(priority["mandatory_reserve_ms"]),
        # Mandatory work is bounded by the clock but never below its floor.
        "mandatory_cap_ms": max(int(priority["mandatory_floor_ms"]), remaining),
        # Optional work sees only the surplus above the mandatory reserve.
        "optional_cap_ms": min(
            int(priority["optional_envelope_ms"]),
            max(0, remaining - int(priority["mandatory_reserve_ms"])),
        ),
    }


def grant_lane_budget_ms(
    policy: dict[str, Any], caps: dict[str, Any], priority_class: str, requested_ms: int
) -> dict[str, Any]:
    """One lane's grant. Optional work can be starved; mandatory work cannot."""
    priority = policy["budget_priority"]
    requested = int(requested_ms)
    if requested <= 0:
        raise ValueError("A lane budget request must be a positive number of milliseconds")
    cap = caps["optional_cap_ms"] if priority_class == "optional" else caps["mandatory_cap_ms"]
    if cap is None:
        return {"requested_ms": requested, "granted_ms": requested, "starved": False}
    if priority_class == "optional":
        granted = min(requested, int(cap))
        if granted < int(priority["optional_floor_ms"]):
            # Too small to do anything with: the lane is not started, and its
            # existing fault containment closes it at zero authority.
            return {"requested_ms": requested, "granted_ms": 0, "starved": True}
        return {"requested_ms": requested, "granted_ms": granted, "starved": False}
    return {
        "requested_ms": requested,
        "granted_ms": max(int(priority["mandatory_floor_ms"]), min(requested, int(cap))),
        "starved": False,
    }


def resolve_lane_pool_plan(
    *,
    lane_kinds: list[str],
    remaining_compute_ms: int | None = None,
    cpu_count: int | None = None,
    total_memory_mib: int | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The declared plan this pool runs under: workers, caps and lane classes."""
    resolved_policy = policy or load_lane_resource_policy()
    measured_cpu, measured_memory = host_resources(resolved_policy)
    cpus = int(cpu_count) if cpu_count else measured_cpu
    memory_mib = int(total_memory_mib) if total_memory_mib else measured_memory
    criticalities = lane_criticalities()
    max_workers = resolve_lane_worker_count(resolved_policy, len(lane_kinds), cpus, memory_mib)
    reservation = resolved_policy["worker_reservation"]
    return {
        "schema_version": LANE_RESOURCE_PLAN_SCHEMA,
        "policy_schema_version": resolved_policy["schema_version"],
        "policy_sha256": sha256_file(LANE_RESOURCE_POLICY_PATH),
        "order": list(lane_kinds),
        "lane_count": len(lane_kinds),
        "max_workers": max_workers,
        "host": {
            "cpu_count": cpus,
            "total_memory_mib": memory_mib,
            "usable_memory_mib": max(0, memory_mib - int(reservation["reserved_memory_mib"])),
        },
        "worker_reservation": dict(reservation),
        "caps": lane_budget_caps(resolved_policy, remaining_compute_ms),
        "lanes": {
            kind: {
                "criticality": criticalities.get(kind, ""),
                "priority_class": lane_priority_class(criticalities.get(kind, ""), resolved_policy),
            }
            for kind in lane_kinds
        },
    }


def execute_lane_pool(
    *,
    plan: dict[str, Any],
    declarations: dict[str, dict[str, Any]],
    execute: Any,
) -> tuple[dict[str, Any], dict[str, int], dict[str, Any]]:
    """Run the declared lanes under a pool bounded by the PLAN, not by count.

    Returns the lane states, the lane durations and one resource OBSERVATION
    per lane. A lane that shared the pool with another lane declares its cpu
    reading as shared rather than claiming a per-lane measurement the operating
    system never gave it.
    """
    max_workers = max(1, int(plan["max_workers"]))
    order = [kind for kind in (plan.get("order") or list(declarations)) if kind in declarations]
    states: dict[str, Any] = {}
    durations: dict[str, int] = {}
    observations: dict[str, Any] = {}
    guard = threading.Lock()
    active: set[str] = set()
    shared: set[str] = set()
    next_slot = [0]

    def worker(kind: str) -> tuple[dict[str, Any], int]:
        with guard:
            slot = next_slot[0] % max_workers
            next_slot[0] += 1
            if active:
                shared.add(kind)
                shared.update(active)
            active.add(kind)
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        started = time.monotonic()
        try:
            return execute(kind, declarations[kind])
        finally:
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            wall_ms = round((time.monotonic() - started) * 1000)
            with guard:
                active.discard(kind)
                exclusive = kind not in shared
                observations[kind] = {
                    "worker_slot": slot,
                    "wall_ms": wall_ms,
                    "cpu_ms": (
                        round(
                            (
                                (after.ru_utime + after.ru_stime)
                                - (before.ru_utime + before.ru_stime)
                            )
                            * 1000
                        )
                        if exclusive
                        else None
                    ),
                    "cpu_attribution": "exclusive" if exclusive else "pool_shared",
                    "peak_rss_mib": children_peak_rss_mib(after) if exclusive else None,
                }

    if order:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {kind: executor.submit(worker, kind) for kind in order}
            for kind in order:
                states[kind], durations[kind] = futures[kind].result()
    return states, durations, observations


def children_peak_rss_mib(usage: Any) -> int:
    """High-water resident memory across this process's children."""
    raw = int(getattr(usage, "ru_maxrss", 0) or 0)
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    return max(0, raw // divisor)


def compile_lane_resource_receipt(
    *,
    plan: dict[str, Any],
    kind: str,
    grant: dict[str, Any],
    observation: dict[str, Any],
    late_enrichment_after_seal: bool = False,
) -> dict[str, Any]:
    """What one lane was reserved, what it was granted and what it consumed."""
    lane_plan = (plan.get("lanes") or {}).get(kind) or {}
    reservation = plan["worker_reservation"]
    caps = plan["caps"]
    receipt = {
        "schema_version": LANE_RESOURCE_RECEIPT_SCHEMA,
        "lane": kind,
        "priority_class": lane_plan.get("priority_class", "mandatory"),
        "criticality": lane_plan.get("criticality", ""),
        "worker_slot": int(observation.get("worker_slot") or 0),
        "pool_max_workers": int(plan["max_workers"]),
        "reserved_cpu": int(reservation["cpu_per_worker"]),
        "reserved_memory_mib": int(reservation["memory_mib_per_worker"]),
        "requested_budget_ms": int(grant["requested_ms"]),
        "granted_budget_ms": int(grant["granted_ms"]),
        "budget_source": caps["budget_source"],
        "remaining_compute_ms_at_grant": caps["remaining_compute_ms"],
        "consumed_wall_ms": int(observation.get("wall_ms") or 0),
        "consumed_cpu_ms": observation.get("cpu_ms"),
        "cpu_attribution": observation.get("cpu_attribution") or "pool_shared",
        "peak_children_rss_mib": observation.get("peak_rss_mib"),
        "budget_headroom_ms": int(grant["granted_ms"]) - int(observation.get("wall_ms") or 0),
        "starved": bool(grant["starved"]),
        "late_enrichment_after_seal": bool(late_enrichment_after_seal),
    }
    receipt["receipt_sha256"] = sha256_value(receipt)
    return receipt


def _broker_wall_budget_path(output_root: Path) -> Path:
    return output_root / BROKER_WALL_BUDGET_FILE


def _new_broker_wall_budget(limit_ms: int) -> dict[str, Any]:
    return {
        "schema_version": BROKER_WALL_BUDGET_SCHEMA,
        "limit_ms": int(limit_ms),
        "consumed_ms": 0,
        "segments": [],
        "open_segment": None,
        "findings": [],
    }


def _seal_broker_wall_budget(ledger: dict[str, Any]) -> dict[str, Any]:
    body = {key: value for key, value in ledger.items() if key != "receipt_sha256"}
    return {**body, "receipt_sha256": sha256_value(body)}


def _broker_wall_budget_errors(ledger: dict[str, Any], limit_ms: int) -> list[str]:
    errors: list[str] = []
    if ledger.get("schema_version") != BROKER_WALL_BUDGET_SCHEMA:
        errors.append("schema_version")
    if ledger.get("limit_ms") != int(limit_ms):
        errors.append("limit_ms")
    consumed = ledger.get("consumed_ms")
    if not isinstance(consumed, int) or isinstance(consumed, bool) or consumed < 0:
        errors.append("consumed_ms")
    elif consumed > int(limit_ms):
        errors.append("consumed_above_limit")
    segments = ledger.get("segments")
    if not isinstance(segments, list):
        errors.append("segments")
    else:
        charged = 0
        for segment in segments:
            if not isinstance(segment, dict):
                errors.append("segment_shape")
                continue
            value = segment.get("charged_ms")
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                errors.append("segment_charged_ms")
            else:
                charged += value
        if isinstance(consumed, int) and charged != consumed:
            errors.append("segment_reconciliation")
    opened = ledger.get("open_segment")
    if opened is not None and (
        not isinstance(opened, dict)
        or not isinstance(opened.get("segment_id"), str)
        or not isinstance(opened.get("operation"), str)
        or not isinstance(opened.get("started_wall_epoch_ms"), int)
        or not isinstance(opened.get("allowance_ms"), int)
    ):
        errors.append("open_segment")
    declared = ledger.get("receipt_sha256")
    body = {key: value for key, value in ledger.items() if key != "receipt_sha256"}
    if declared != sha256_value(body):
        errors.append("receipt_sha256")
    return sorted(set(errors))


def _persist_broker_wall_budget(output_root: Path, ledger: dict[str, Any]) -> dict[str, Any]:
    sealed = _seal_broker_wall_budget(ledger)
    atomic_json(_broker_wall_budget_path(output_root), sealed)
    return sealed


def _exhausted_broker_wall_budget(
    output_root: Path, limit_ms: int, finding: str
) -> dict[str, Any]:
    """Fail a broken optional clock closed without blocking mandatory evidence."""
    ledger = _new_broker_wall_budget(limit_ms)
    ledger["consumed_ms"] = int(limit_ms)
    ledger["segments"] = [{
        "segment_id": f"fail-closed-{time.time_ns()}",
        "operation": "broker_wall_budget_fail_closed",
        "observed_ms": int(limit_ms),
        "charged_ms": int(limit_ms),
        "overrun_ms": 0,
        "outcome": "FAIL_CLOSED",
    }]
    ledger["findings"] = [str(finding)]
    return _persist_broker_wall_budget(output_root, ledger)


def _load_broker_wall_budget(
    output_root: Path,
    *,
    limit_ms: int,
    now_wall_epoch_ms: int | None = None,
    sweep_open: bool = True,
) -> dict[str, Any]:
    """Open the persisted broker clock and charge an abandoned invocation."""
    target = _broker_wall_budget_path(output_root)
    now_wall = int(now_wall_epoch_ms if now_wall_epoch_ms is not None else time.time() * 1000)
    if not target.is_file():
        return _persist_broker_wall_budget(output_root, _new_broker_wall_budget(limit_ms))
    try:
        ledger = read_json(target, "broker wall budget")
    except (OSError, ValueError) as error:
        return _exhausted_broker_wall_budget(output_root, limit_ms, str(error))
    errors = _broker_wall_budget_errors(ledger, limit_ms)
    if errors:
        return _exhausted_broker_wall_budget(
            output_root,
            limit_ms,
            "invalid persisted broker wall budget: " + ", ".join(errors),
        )
    opened = ledger.get("open_segment")
    if opened is not None and sweep_open:
        started_wall = int(opened["started_wall_epoch_ms"])
        remaining = max(0, int(limit_ms) - int(ledger["consumed_ms"]))
        if now_wall < started_wall:
            observed = remaining
            outcome = "ABANDONED_CLOCK_SKEW_FAIL_CLOSED"
        else:
            observed = max(0, now_wall - started_wall)
            outcome = "ABANDONED_INVOCATION"
        charged = min(remaining, observed)
        ledger["segments"].append({
            "segment_id": opened["segment_id"],
            "operation": opened["operation"],
            "observed_ms": observed,
            "charged_ms": charged,
            "overrun_ms": max(0, observed - charged),
            "outcome": outcome,
        })
        ledger["consumed_ms"] += charged
        ledger["open_segment"] = None
        ledger.setdefault("findings", []).append(outcome.lower())
        ledger = _persist_broker_wall_budget(output_root, ledger)
    return ledger


def begin_broker_wall_segment(
    output_root: Path,
    operation: str,
    *,
    requested_ms: int,
    limit_ms: int,
    now_wall_epoch_ms: int | None = None,
    now_monotonic_ms: float | None = None,
) -> dict[str, Any]:
    """Reserve one slice from the one persisted optional-broker wall envelope."""
    ledger = _load_broker_wall_budget(
        output_root,
        limit_ms=limit_ms,
        now_wall_epoch_ms=now_wall_epoch_ms,
    )
    remaining = max(0, int(limit_ms) - int(ledger["consumed_ms"]))
    allowance = min(remaining, max(0, int(requested_ms)))
    if allowance < BROKER_MIN_EXECUTION_SLICE_MS:
        return {
            "started": False,
            "allowance_ms": allowance,
            "remaining_ms": remaining,
            "limit_ms": int(limit_ms),
        }
    wall = int(now_wall_epoch_ms if now_wall_epoch_ms is not None else time.time() * 1000)
    monotonic = float(
        now_monotonic_ms if now_monotonic_ms is not None else time.monotonic() * 1000
    )
    segment_id = f"{os.getpid()}-{time.time_ns()}-{len(ledger['segments']) + 1}"
    ledger["open_segment"] = {
        "segment_id": segment_id,
        "operation": str(operation),
        "started_wall_epoch_ms": wall,
        "allowance_ms": allowance,
        "pid": os.getpid(),
    }
    _persist_broker_wall_budget(output_root, ledger)
    return {
        "started": True,
        "segment_id": segment_id,
        "operation": str(operation),
        "started_wall_epoch_ms": wall,
        "started_monotonic_ms": monotonic,
        "allowance_ms": allowance,
        "remaining_ms": remaining,
        "limit_ms": int(limit_ms),
    }


def end_broker_wall_segment(
    output_root: Path,
    token: dict[str, Any],
    *,
    outcome: str,
    now_wall_epoch_ms: int | None = None,
    now_monotonic_ms: float | None = None,
) -> dict[str, Any]:
    """Charge the larger monotonic/wall observation and close the persisted slice."""
    limit_ms = int(token["limit_ms"])
    ledger = _load_broker_wall_budget(
        output_root,
        limit_ms=limit_ms,
        now_wall_epoch_ms=token["started_wall_epoch_ms"],
        sweep_open=False,
    )
    opened = ledger.get("open_segment")
    if not token.get("started") or not opened or opened.get("segment_id") != token.get("segment_id"):
        return _exhausted_broker_wall_budget(
            output_root,
            limit_ms,
            "broker wall segment custody mismatch",
        )
    wall = int(now_wall_epoch_ms if now_wall_epoch_ms is not None else time.time() * 1000)
    monotonic = float(
        now_monotonic_ms if now_monotonic_ms is not None else time.monotonic() * 1000
    )
    wall_elapsed = max(0, wall - int(token["started_wall_epoch_ms"]))
    monotonic_elapsed = max(0, round(monotonic - float(token["started_monotonic_ms"])))
    observed = max(wall_elapsed, monotonic_elapsed)
    remaining = max(0, limit_ms - int(ledger["consumed_ms"]))
    charged = min(remaining, observed)
    ledger["segments"].append({
        "segment_id": token["segment_id"],
        "operation": token["operation"],
        "observed_ms": observed,
        "charged_ms": charged,
        "overrun_ms": max(0, observed - int(token["allowance_ms"])),
        "outcome": str(outcome),
    })
    ledger["consumed_ms"] += charged
    ledger["open_segment"] = None
    return _persist_broker_wall_budget(output_root, ledger)


def broker_wall_remaining_ms(output_root: Path, *, limit_ms: int) -> int:
    ledger = _load_broker_wall_budget(output_root, limit_ms=limit_ms)
    return max(0, int(limit_ms) - int(ledger["consumed_ms"]))


"""The budget slice granted to each lane currently in flight, in ms.

Written by the pool before the lane starts and read by `run_lane` when it sets
the lane's watchdog. It is a registry rather than a `run_lane` parameter
because `run_lane`'s four-argument boundary is the one the lane test doubles
stand on; the grant is per-lane-kind and written by the same thread that reads
it, so concurrent lanes never contend.
"""
ACTIVE_LANE_BUDGET_MS: dict[str, int] = {}


def effective_lane_timeout_seconds(kind: str, request_path: Path) -> int:
    """The lane's declared watchdog, bounded by the pool's budget grant.

    A grant can SHORTEN a lane's own timer; it can never lengthen it. With no
    grant recorded the declared budget applies unchanged.
    """
    declared = lane_timeout_budget(kind, request_path)
    granted_ms = ACTIVE_LANE_BUDGET_MS.get(kind)
    if granted_ms is None:
        return declared
    return max(1, min(declared, int(granted_ms) // 1000))


def assert_lane_resource_receipts_complete(
    executed_lane_kinds: list[str], receipts: list[dict[str, Any]]
) -> None:
    """A lane that RAN and recorded nothing is a refusal, not a silence."""
    seen = {str(receipt.get("lane")) for receipt in receipts}
    missing = [kind for kind in executed_lane_kinds if kind not in seen]
    if missing:
        raise ValueError(
            "These lanes ran without a resource receipt: " + ", ".join(sorted(missing))
        )
    for receipt in receipts:
        granted = receipt.get("granted_budget_ms")
        consumed = receipt.get("consumed_wall_ms")
        headroom = receipt.get("budget_headroom_ms")
        if (
            not isinstance(granted, int)
            or not isinstance(consumed, int)
            or not isinstance(headroom, int)
            or consumed > granted
            or headroom < 0
            or headroom != granted - consumed
        ):
            raise ValueError(
                f"Lane resource receipt for {receipt.get('lane')} exceeded or misstated its grant"
            )


def lane_command(kind: str, declaration: dict[str, Any], base: Path, output_root: Path) -> list[str]:
    request = resolve(base, declaration.get("request_path"))
    if kind == "filings":
        command = [
            NODE_EXECUTABLE,
            str(HERE / "run_filings_pipeline.mjs"),
            str(request),
            "--out",
            str(output_root / kind),
            "--source-acquisition-timeout-ms",
            "120000",
            "--filing-extraction-timeout-ms",
            "480000",
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
    if kind == "broker":
        command.extend([
            "--native-timeout-ms", "120000",
            "--semantic-frontier-timeout-ms", "180000",
        ])
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
    # The lane's own declared watchdog, bounded by whatever budget the pool
    # plan granted this lane. A grant never LENGTHENS a lane's own timer.
    lane_budget_seconds = effective_lane_timeout_seconds(kind, request_path)
    lane_started_monotonic_ms = time.monotonic() * 1000
    broker_limit_ms = int(
        load_lane_resource_policy()["budget_priority"]["optional_envelope_ms"]
    ) if kind == "broker" else 0
    primary_token: dict[str, Any] | None = None
    if kind == "broker":
        primary_token = begin_broker_wall_segment(
            output_root,
            "broker_primary",
            requested_ms=lane_budget_seconds * 1000,
            limit_ms=broker_limit_ms,
        )
    if kind != "broker" or primary_token.get("started"):
        primary_timeout_seconds = lane_budget_seconds if kind != "broker" else max(
            1, int(primary_token["allowance_ms"]) // 1000
        )
        try:
            completed = run(command, timeout_seconds=primary_timeout_seconds)
        finally:
            if primary_token is not None and primary_token.get("started"):
                end_broker_wall_segment(
                    output_root,
                    primary_token,
                    outcome=(
                        "PASS" if "completed" in locals() and completed.returncode in {0, 2}
                        else "TIMEOUT_OR_FAILURE"
                    ),
                )
    else:
        completed = subprocess.CompletedProcess(
            command,
            124,
            "",
            "broker wall envelope exhausted before optional broker processing could start",
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
            # Optional close is part of the SAME 720-second broker wall budget
            # and the SAME pool grant. It receives only what primary did not
            # consume; it never gets a fresh three minutes after the envelope.
            invocation_elapsed_ms = max(
                0, round(time.monotonic() * 1000 - lane_started_monotonic_ms)
            )
            invocation_remaining_ms = max(
                0, lane_budget_seconds * 1000 - invocation_elapsed_ms
            )
            close_requested_ms = min(
                BROKER_OPTIONAL_CLOSE_MAX_MS,
                invocation_remaining_ms,
                broker_wall_remaining_ms(output_root, limit_ms=broker_limit_ms),
            )
            close_token = begin_broker_wall_segment(
                output_root,
                "broker_optional_close",
                requested_ms=close_requested_ms,
                limit_ms=broker_limit_ms,
            )
            if close_token.get("started"):
                try:
                    closed = run(
                        [*command, "--close-optional"],
                        timeout_seconds=max(1, int(close_token["allowance_ms"]) // 1000),
                    )
                finally:
                    end_broker_wall_segment(
                        output_root,
                        close_token,
                        outcome=(
                            "PASS" if "closed" in locals() and closed.returncode in {0, 2}
                            else "TIMEOUT_OR_FAILURE"
                        ),
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
            source_line_id = str(row.get("source_line_id") or "")
            source_suffix = re.split(r"[.:/]", source_line_id)[-1]
            label_id = re.sub(
                r"[^a-z0-9]+", "_", str(row.get("label") or "").lower()
            ).strip("_")
            candidates = [
                row.get("broker_metric_id"),
                row.get("semantic_role"),
                row.get("row_id"),
                source_line_id,
                source_suffix,
                label_id,
            ]
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


def filings_bundle_path(filings_state: dict[str, Any] | None) -> Path:
    raw = (filings_state or {}).get("artifacts", {}).get("filings_bundle")
    target = Path(str(raw or "")).resolve()
    if not target.is_file():
        raise FileNotFoundError(
            "PASS filings topology omitted its controller-owned filings bundle"
        )
    return target


def write_pre_broker_demand_from_filings(
    *,
    spec: dict[str, Any],
    output_root: Path,
    filings_state: dict[str, Any],
) -> Path:
    bundle_path = filings_bundle_path(filings_state)
    bundle = read_json(bundle_path, "filings bundle for pre-broker demand")
    demand = _model_owned_broker_demand(
        request={"run_id": spec.get("run_id")},
        spec=spec,
        filings=bundle.get("filings") or {},
    )
    demand_path = output_root / "internal-requests" / "pre-broker-model-demand.json"
    atomic_json(demand_path, demand)
    return demand_path


def run_structural_ownership_preflight(
    *,
    filings_state: dict[str, Any],
    demand_path: Path,
    output_root: Path,
) -> tuple[dict[str, Any], Path, int]:
    """Compile and reopen-verify Preflight A before descendant evidence work."""
    started = time.monotonic()
    bundle_path = filings_bundle_path(filings_state)
    receipt_path = output_root / "ownership" / "structural-ownership-preflight.json"
    command = [
        NODE_EXECUTABLE,
        str(HERE / "run_structural_ownership_preflight.mjs"),
        str(bundle_path),
        str(demand_path),
        "--out",
        str(receipt_path),
    ]
    completed = run(command, timeout_seconds=120)
    if completed.returncode not in {0, 2} or not receipt_path.is_file():
        raise RuntimeError(
            (completed.stderr or completed.stdout).strip()[-4000:]
            or "Structural ownership preflight did not write a receipt"
        )
    verify_path = output_root / "ownership" / "structural-ownership-preflight.verified.json"
    verified = run(
        [
            NODE_EXECUTABLE,
            str(HERE / "run_structural_ownership_preflight.mjs"),
            str(bundle_path),
            str(demand_path),
            "--verify",
            str(receipt_path),
            "--out",
            str(verify_path),
        ],
        timeout_seconds=120,
    )
    if verified.returncode not in {0, 2} or not verify_path.is_file():
        raise RuntimeError(
            (verified.stderr or verified.stdout).strip()[-4000:]
            or "Structural ownership preflight receipt did not reverify"
        )
    receipt = read_json(verify_path, "verified structural ownership preflight")
    if (
        receipt.get("checkpoint") != "A_STRUCTURAL"
        or receipt.get("status") not in {"PASS", "BLOCK"}
    ):
        raise ValueError("Structural ownership preflight has an invalid sealed status")
    if receipt_path.read_bytes() != verify_path.read_bytes():
        raise ValueError("Structural ownership preflight changed during reopen verification")
    return receipt, receipt_path, round((time.monotonic() - started) * 1000)


def project_broker_demand_to_structural_owners(
    *,
    structural_receipt: dict[str, Any],
    demand_path: Path,
    broker_declaration: dict[str, Any] | None,
    output_root: Path,
) -> tuple[Path, Path]:
    """Rewrite the graph consumed by the broker lane to its sole structural owners.

    The structural receipt carries exact demand-node identities, not a label or
    metric heuristic.  The projection receipt binds the original graph, the A
    receipt and the projected graph.  Any ambiguity fails before a descendant
    lane can start.
    """
    if structural_receipt.get("status") != "PASS":
        raise ValueError("Cannot project broker demand from a non-PASS structural receipt")
    structural_hash = str(structural_receipt.get("receipt_sha256") or "")
    receipt_body = {key: value for key, value in structural_receipt.items() if key != "receipt_sha256"}
    if len(structural_hash) != 64 or structural_hash != sha256_node_value(receipt_body):
        raise ValueError("Structural ownership receipt is stale before broker-demand projection")
    graph = read_json(demand_path, "unprojected pre-broker demand graph")
    graph_hash = str(graph.get("graph_sha256") or "")
    graph_body = {key: value for key, value in graph.items() if key != "graph_sha256"}
    if len(graph_hash) != 64 or graph_hash != sha256_value(graph_body):
        raise ValueError("Pre-broker demand graph is stale before ownership projection")
    nodes = list(graph.get("nodes") or [])
    node_ids = [str(node.get("node_id") or "") for node in nodes]
    if any(not node_id for node_id in node_ids) or len(set(node_ids)) != len(node_ids):
        raise ValueError("Pre-broker demand graph node identities are absent or duplicated")
    available = set(node_ids)
    candidate: set[str] = set()
    owners: set[str] = set()
    for family in structural_receipt.get("families") or []:
        family_candidates = set(map(str, family.get("candidate_broker_demand_node_ids") or []))
        family_owners = set(map(str, family.get("broker_demand_owner_node_ids") or []))
        if family.get("candidate_broker_demand_row_ids") and not family_candidates:
            raise ValueError("Structural ownership projection cannot bind demand rows to graph nodes")
        if not family_owners.issubset(family_candidates):
            raise ValueError("Structural ownership projection contains an owner outside its candidate set")
        if not family_candidates.issubset(available):
            raise ValueError("Structural ownership projection references a missing demand node")
        conflicting = candidate.intersection(family_candidates)
        if conflicting and any(
            (node_id in owners) != (node_id in family_owners)
            for node_id in conflicting
        ):
            raise ValueError("A demand node has conflicting structural owners")
        candidate.update(family_candidates)
        owners.update(family_owners)
    rejected = candidate - owners
    projected_nodes = [node for node in nodes if str(node.get("node_id")) not in rejected]
    projected = dict(graph_body)
    projected["nodes"] = projected_nodes
    counts = dict(projected.get("counts") or {})
    demand_nodes = [
        node for node in projected_nodes
        if graph.get("schema_version") == "pre-broker-model-demand/1.0"
        or node.get("node_kind") == "model_demand"
    ]
    counts["source_rows"] = len({
        str(node.get("source_line_id")) for node in demand_nodes if node.get("source_line_id")
    })
    if graph.get("schema_version") == "pre-broker-model-demand/1.0":
        for key in (
            "model_demand_concepts",
            "model_demand_nodes",
            "material_model_demand_nodes",
        ):
            counts.pop(key, None)
        counts["forecast_nodes"] = len(demand_nodes)
        counts["material_nodes"] = sum(
            1 for node in demand_nodes if node.get("material") is True
        )
    else:
        counts.pop("forecast_nodes", None)
        counts.pop("material_nodes", None)
        counts["model_demand_concepts"] = len({
            str(node.get("metric_id")) for node in demand_nodes if node.get("metric_id")
        })
        counts["model_demand_nodes"] = len(demand_nodes)
        counts["material_model_demand_nodes"] = sum(
            1 for node in demand_nodes if node.get("material") is True
        )
    projected["counts"] = counts
    projected_graph = {**projected, "graph_sha256": sha256_value(projected)}
    projection_body = {
        "schema_version": "pre-broker-demand-ownership-projection/1.0",
        "status": "PASS",
        "structural_receipt_sha256": structural_hash,
        "input_graph_sha256": graph_hash,
        "output_graph_sha256": projected_graph["graph_sha256"],
        "candidate_node_ids": sorted(candidate),
        "owner_node_ids": sorted(owners),
        "rejected_node_ids": sorted(rejected),
        "counts": {
            "input_nodes": len(nodes),
            "output_nodes": len(projected_nodes),
            "rejected_nodes": len(rejected),
        },
    }
    projection_receipt = {
        **projection_body,
        "receipt_sha256": sha256_value(projection_body),
    }
    atomic_json(demand_path, projected_graph)
    projection_path = output_root / "ownership" / "broker-demand-ownership-projection.json"
    atomic_json(projection_path, projection_receipt)
    if broker_declaration is not None:
        request_path = Path(str(broker_declaration.get("request_path") or "")).resolve()
        if not request_path.is_file():
            raise ValueError("Broker descendant lacks a controller-owned request to project")
        request = read_json(request_path, "broker request for ownership projection")
        context = request.get("model_context")
        if not isinstance(context, dict) or not isinstance(context.get("model_demand_graph"), dict):
            raise ValueError("Broker descendant request lacks its demand graph")
        context["model_demand_graph"] = projected_graph
        atomic_json(request_path, request)
    verify_broker_demand_projection(
        demand_path=demand_path,
        projection_path=projection_path,
        structural_receipt=structural_receipt,
        broker_declaration=broker_declaration,
    )
    return demand_path, projection_path


def verify_broker_demand_projection(
    *,
    demand_path: Path,
    projection_path: Path,
    structural_receipt: dict[str, Any],
    broker_declaration: dict[str, Any] | None,
) -> None:
    graph = read_json(demand_path, "projected pre-broker demand graph")
    receipt = read_json(projection_path, "broker-demand ownership projection")
    receipt_hash = receipt.pop("receipt_sha256", None)
    if receipt_hash != sha256_value(receipt):
        raise ValueError("Broker-demand ownership projection receipt is stale")
    graph_hash = graph.get("graph_sha256")
    graph_body = {key: value for key, value in graph.items() if key != "graph_sha256"}
    if graph_hash != sha256_value(graph_body):
        raise ValueError("Projected broker-demand graph is stale")
    if (
        receipt.get("status") != "PASS"
        or receipt.get("structural_receipt_sha256") != structural_receipt.get("receipt_sha256")
        or receipt.get("output_graph_sha256") != graph_hash
    ):
        raise ValueError("Projected broker demand is not bound to the active structural receipt")
    actual_ids = {str(node.get("node_id")) for node in graph.get("nodes") or []}
    if actual_ids.intersection(set(receipt.get("rejected_node_ids") or [])):
        raise ValueError("Rejected child demand remains in the broker graph")
    if not set(receipt.get("owner_node_ids") or []).issubset(actual_ids):
        raise ValueError("Owned demand is missing from the broker graph")
    if broker_declaration is not None:
        request = read_json(
            Path(str(broker_declaration.get("request_path") or "")).resolve(),
            "projected broker request",
        )
        request_graph = (request.get("model_context") or {}).get("model_demand_graph")
        request_graph_body = {
            key: value for key, value in (request_graph or {}).items()
            if key != "graph_sha256"
        }
        if (
            not isinstance(request_graph, dict)
            or request_graph.get("graph_sha256") != sha256_value(request_graph_body)
            or request_graph != graph
        ):
            raise ValueError("Broker request does not carry the sealed projected demand graph")

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
    controller_summary: dict[str, Any] | None = None,
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
    if not underlying:
        # A controller exception can occur before the subordinate lane has had
        # a chance to mint its ordinary task array. The aggregate must still
        # name a concrete lane defect; `underlying_defect_count: 0` beside a
        # terminal internal failure is false evidence and cannot guide repair.
        for lane, state in sorted(lanes.items()):
            if state.get("pipeline_status") != "BLOCKED_INTERNAL":
                continue
            terminal_reason = (state.get("summary") or {}).get(
                "terminal_reason", f"{lane}_controller_internal_failure"
            )
            defect_sha = sha256_value({
                "lane": lane,
                "terminal_reason": terminal_reason,
                "message": (state.get("summary") or {}).get("message"),
            })
            underlying.append({
                "lane": lane,
                "task_id": f"{lane}-controller-defect-{defect_sha[:16]}",
                "task_kind": "controller_terminal_failure",
                "terminal_reasons": [terminal_reason],
            })
    if not underlying and controller_summary:
        terminal_reason = controller_summary.get(
            "terminal_reason", "attachment_controller_internal_failure"
        )
        controller_signal = controller_summary.get("controller_signal") or {}
        lane = controller_signal.get("resume_from") or "attachment"
        defect_sha = sha256_value({
            "lane": lane,
            "terminal_reason": terminal_reason,
            "message": controller_summary.get("message"),
        })
        underlying.append({
            "lane": lane,
            "task_id": f"{lane}-controller-defect-{defect_sha[:16]}",
            "task_kind": "controller_terminal_failure",
            "terminal_reasons": [terminal_reason],
        })
    if not underlying:
        raise RuntimeError(
            "BLOCKED_INTERNAL has no blocked lane from which to derive a terminal defect"
        )
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
        controller_summary=summary,
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
_ACTIVE_EXPERIENCE_TRACE: ExperienceTrace | None = None
_ACTIVE_EXPERIENCE_SPAN: Any = None
_EXPERIENCE_TRACE_FINISHED = False

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


def _finish_experience_trace(error: BaseException | None) -> None:
    """Close the root span with the real terminal outcome exactly once."""
    global _EXPERIENCE_TRACE_FINISHED
    if _EXPERIENCE_TRACE_FINISHED or _ACTIVE_EXPERIENCE_TRACE is None:
        return
    _EXPERIENCE_TRACE_FINISHED = True
    try:
        if error is None:
            _ACTIVE_EXPERIENCE_SPAN.__exit__(None, None, None)
        else:
            _ACTIVE_EXPERIENCE_SPAN.__exit__(type(error), error, error.__traceback__)
    finally:
        output_root = getattr(_ACTIVE_EXPERIENCE_TRACE, "_output_root", None)
        if output_root is not None:
            write_trace(Path(output_root) / "experience-trace.json", _ACTIVE_EXPERIENCE_TRACE.finish())

def main() -> int:
    global _ACTIVE_EXPERIENCE_TRACE, _ACTIVE_EXPERIENCE_SPAN
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
    experience_trace._output_root = output_root
    _ACTIVE_EXPERIENCE_TRACE = experience_trace
    _ACTIVE_EXPERIENCE_SPAN = experience_span
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
    reusable_mandatory_lanes: dict[str, dict[str, Any]] = {}
    prior_attachment_state: dict[str, Any] = {}
    if args.force_zero_broker and state_path.is_file():
        prior_attachment_state = read_json(state_path, "prior attachment evidence state")
        if (
            prior_attachment_state.get("controller_spec_sha256") != spec_hash
            or prior_attachment_state.get("runtime_closure_sha256") != runtime_hash
        ):
            raise ValueError("Zero-broker resume cannot reuse evidence from a different spec/runtime closure")
        prior_checkpoints = {
            item.get("stage"): item for item in prior_attachment_state.get("checkpoints") or []
        }
        for kind in ("filings", "dcs"):
            if not spec.get(kind):
                continue
            recorded_lane = (prior_attachment_state.get("lane_states") or {}).get(kind)
            lane_state_path = output_root / kind / f"{kind}-run-state.json"
            expected_state_sha = (prior_checkpoints.get(kind) or {}).get("state_sha256")
            lane = read_json(lane_state_path, f"reusable {kind} lane state") if lane_state_path.is_file() else None
            if (
                not isinstance(lane, dict)
                or lane.get("pipeline_status") not in CLOSED_LANE_STATUSES
                or not lane_state_path.is_file()
                or expected_state_sha != sha256_file(lane_state_path)
                or sha256_value(recorded_lane) != sha256_value(lane)
            ):
                raise ValueError(f"Zero-broker resume lacks a hash-bound closed {kind} checkpoint")
            reusable_mandatory_lanes[kind] = lane
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
    if reusable_mandatory_lanes:
        for name in ("pre_broker_model_demand", "structural_ownership_preflight"):
            target = (prior_attachment_state.get("artifacts") or {}).get(name)
            if target and Path(target).is_file():
                derived_artifacts[name] = str(target)
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
    # P6.5 — one declared resource policy, one budget reading from P6.1's clock.
    lane_policy = load_lane_resource_policy()
    lane_remaining_compute_ms = run_deadline_remaining_ms()
    lane_grants: dict[str, dict[str, Any]] = {}
    lane_observations: dict[str, dict[str, Any]] = {}
    lane_resource_receipts: list[dict[str, Any]] = []
    lane_plans: list[dict[str, Any]] = []
    executed_lane_kinds: list[str] = []
    structural_seal_monotonic_ms: float | None = None

    def lane_pool_plan(lane_kinds: list[str]) -> dict[str, Any]:
        plan = resolve_lane_pool_plan(
            lane_kinds=lane_kinds,
            remaining_compute_ms=lane_remaining_compute_ms,
            policy=lane_policy,
        )
        lane_plans.append(plan)
        return plan

    def flush_lane_resources() -> None:
        """Disclose what each lane reserved, was granted and consumed.

        Written before every terminal state below, so a blocked run discloses
        its resource consumption exactly as a passing one does.
        """
        assert_lane_resource_receipts_complete(executed_lane_kinds, lane_resource_receipts)
        target = output_root / "lane-resource-receipts.json"
        payload = {
            "schema_version": LANE_RESOURCE_RECEIPTS_SCHEMA,
            "run_id": str(spec.get("run_id") or ""),
            "plans": lane_plans,
            "receipts": lane_resource_receipts,
        }
        payload["receipt_sha256"] = sha256_value(payload)
        atomic_json(target, payload)
        derived_artifacts["lane_resource_receipts"] = str(target)
        broker_wall_budget_path = _broker_wall_budget_path(output_root)
        if broker_wall_budget_path.is_file():
            derived_artifacts["broker_wall_budget"] = str(broker_wall_budget_path)

    def execute_lane(
        kind: str, declaration: dict[str, Any], plan: dict[str, Any]
    ) -> tuple[dict[str, Any], int]:
        started = time.monotonic()
        priority_class = ((plan.get("lanes") or {}).get(kind) or {}).get(
            "priority_class", "mandatory"
        )
        request_path = Path(lane_command(kind, declaration, spec_path.parent, output_root)[2])
        grant = grant_lane_budget_ms(
            lane_policy,
            plan["caps"],
            priority_class,
            lane_timeout_budget(kind, request_path) * 1000,
        )
        lane_grants[kind] = grant
        executed_lane_kinds.append(kind)
        try:
            if kind == "broker" and args.force_zero_broker:
                raise RuntimeError(
                    "The top-level optional-broker circuit breaker requested zero authority"
                )
            if grant["starved"]:
                # Optional work never starts on budget the mandatory path needs.
                # The lane's existing containment closes it at zero authority.
                raise RuntimeError(
                    f"Optional {kind} lane timeout before start: the remaining run budget "
                    f"({plan['caps']['remaining_compute_ms']} ms) is reserved for mandatory work "
                    f"({plan['caps']['mandatory_reserve_ms']} ms), leaving no optional slice"
                )
            ACTIVE_LANE_BUDGET_MS[kind] = grant["granted_ms"]
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
    # first. Its topology and model-owned demand must then pass sealed
    # structural ownership Preflight A before any broker or debt process may
    # launch. A zero-broker downstream resume reopens its hash-bound filings
    # checkpoint instead of re-entering the filings controller.
    if not lane_requires_execution("filings", reusable_mandatory_lanes):
        lanes["filings"] = reusable_mandatory_lanes["filings"]
        lane_duration_ms["filings"] = 0
    elif spec.get("filings"):
        filings_plan = lane_pool_plan(["filings"])
        filings_states, filings_durations, filings_observations = execute_lane_pool(
            plan=filings_plan,
            declarations={"filings": spec["filings"]},
            execute=lambda kind, declaration: execute_lane(kind, declaration, filings_plan),
        )
        lanes["filings"] = filings_states["filings"]
        lane_duration_ms["filings"] = filings_durations["filings"]
        lane_observations.update(filings_observations)
        lane_resource_receipts.append(compile_lane_resource_receipt(
            plan=filings_plan,
            kind="filings",
            grant=lane_grants["filings"],
            observation=filings_observations["filings"],
        ))
    flush_lane_resources()

    if "filings" not in lanes:
        raise ValueError(
            "Broker or debt evidence cannot start before a controller-owned filings topology"
        )
    state_paths["filings"] = output_root / "filings" / "filings-run-state.json"
    checkpoints.append({
        "stage": "filings",
        "status": lanes["filings"].get("pipeline_status"),
        "state_sha256": sha256_file(state_paths["filings"])
        if state_paths["filings"].is_file() else None,
        "duration_ms": lane_duration_ms.get("filings"),
    })
    if lanes["filings"].get("pipeline_status") != "PASS":
        status, blocker, user_blocking = classify(lanes)
        write_state(
            state_path, spec=spec, spec_hash=spec_hash, runtime_hash=runtime_hash,
            status=status, blocker=blocker, user_blocking=user_blocking,
            lanes=lanes, checkpoints=checkpoints, artifacts=derived_artifacts,
            tasks=[
                {"lane": "filings", **task}
                for task in lanes["filings"].get("tasks", [])
            ],
            summary={
                "terminal_reason": "filings_topology_not_closed",
                "descendant_lanes_started": [],
                "performance": {
                    "lane_duration_ms": lane_duration_ms,
                    "lane_resource_receipts": lane_resource_receipts,
                },
            },
        )
        return 2

    concurrent_declarations: dict[str, dict[str, Any]] = {}
    demand_path: Path | None = None
    if spec.get("broker"):
        broker_declaration = broker_declaration_with_model_context(
            spec=spec,
            spec_path=spec_path,
            output_root=output_root,
            filings_state=lanes.get("filings"),
        )
        if broker_declaration.get("model_demand_path"):
            demand_path = Path(str(broker_declaration.pop("model_demand_path"))).resolve()
        concurrent_declarations["broker"] = broker_declaration
    if demand_path is None:
        demand_path = write_pre_broker_demand_from_filings(
            spec=spec,
            output_root=output_root,
            filings_state=lanes["filings"],
        )
    derived_artifacts["pre_broker_model_demand"] = str(demand_path)
    try:
        structural_receipt, structural_path, structural_duration_ms = (
            run_structural_ownership_preflight(
                filings_state=lanes["filings"],
                demand_path=demand_path,
                output_root=output_root,
            )
        )
    except Exception as error:
        checkpoints.append({
            "stage": "structural_ownership_preflight",
            "status": "BLOCKED",
            "state_sha256": None,
            "duration_ms": None,
        })
        write_state(
            state_path, spec=spec, spec_hash=spec_hash, runtime_hash=runtime_hash,
            status="BLOCKED_INTERNAL", blocker="INTERNAL_WORK",
            user_blocking=False, lanes=lanes, checkpoints=checkpoints,
            artifacts=derived_artifacts, tasks=[],
            summary={
                "terminal_reason": "structural_ownership_preflight_blocked",
                "message": str(error),
                "descendant_lanes_started": [],
                "controller_signal": {
                    "action": "cancel_descendants_preserve_checkpoint",
                    "resume_from": "structural_ownership",
                },
                "performance": {
                    "lane_duration_ms": lane_duration_ms,
                    "lane_resource_receipts": lane_resource_receipts,
                },
            },
        )
        return 2
    derived_artifacts["structural_ownership_preflight"] = str(structural_path)
    lane_duration_ms["structural_ownership_preflight"] = structural_duration_ms
    checkpoints.append({
        "stage": "structural_ownership_preflight",
        "status": structural_receipt["status"],
        "state_sha256": sha256_file(structural_path),
        "receipt_sha256": structural_receipt["receipt_sha256"],
        "duration_ms": structural_duration_ms,
    })
    if (
        structural_receipt.get("status") != "PASS"
        or (structural_receipt.get("controller_signal") or {}).get("action")
        != "continue"
    ):
        write_state(
            state_path, spec=spec, spec_hash=spec_hash, runtime_hash=runtime_hash,
            status="BLOCKED_INTERNAL", blocker="INTERNAL_WORK",
            user_blocking=False, lanes=lanes, checkpoints=checkpoints,
            artifacts=derived_artifacts, tasks=[],
            summary={
                "terminal_reason": "structural_ownership_preflight_blocked",
                "message": "; ".join(structural_receipt.get("violations") or []),
                "descendant_lanes_started": [],
                "controller_signal": structural_receipt.get("controller_signal"),
                "performance": {
                    "lane_duration_ms": lane_duration_ms,
                    "lane_resource_receipts": lane_resource_receipts,
                },
            },
        )
        return 2
    # Structural ownership is now SEALED. Anything an optional lane selects
    # after this instant is late enrichment unless it was projected onto the
    # seal first (the projection immediately below).
    structural_seal_monotonic_ms = time.monotonic() * 1000
    try:
        demand_path, projection_path = project_broker_demand_to_structural_owners(
            structural_receipt=structural_receipt,
            demand_path=demand_path,
            broker_declaration=concurrent_declarations.get("broker"),
            output_root=output_root,
        )
        # Reopen the exact artifacts returned by the projection boundary.  The
        # helper verifies before returning as well; this second read closes the
        # handoff so a stale request can never reach executor submission.
        verify_broker_demand_projection(
            demand_path=demand_path,
            projection_path=projection_path,
            structural_receipt=structural_receipt,
            broker_declaration=concurrent_declarations.get("broker"),
        )
        derived_artifacts["pre_broker_model_demand"] = str(demand_path)
        derived_artifacts["broker_demand_ownership_projection"] = str(projection_path)
        checkpoints.append({
            "stage": "broker_demand_ownership_projection",
            "status": "PASS",
            "state_sha256": sha256_file(projection_path),
        })
    except Exception as error:
        checkpoints.append({
            "stage": "broker_demand_ownership_projection",
            "status": "BLOCKED",
            "state_sha256": None,
        })
        write_state(
            state_path, spec=spec, spec_hash=spec_hash, runtime_hash=runtime_hash,
            status="BLOCKED_INTERNAL", blocker="INTERNAL_WORK",
            user_blocking=False, lanes=lanes, checkpoints=checkpoints,
            artifacts=derived_artifacts, tasks=[],
            summary={
                "terminal_reason": "broker_demand_ownership_projection_blocked",
                "message": str(error),
                "descendant_lanes_started": [],
                "controller_signal": {
                    "action": "cancel_descendants_preserve_checkpoint",
                    "resume_from": "structural_ownership",
                },
                "performance": {
                    "lane_duration_ms": lane_duration_ms,
                    "lane_resource_receipts": lane_resource_receipts,
                },
            },
        )
        return 2
    if not lane_requires_execution("dcs", reusable_mandatory_lanes):
        lanes["dcs"] = reusable_mandatory_lanes["dcs"]
        lane_duration_ms["dcs"] = 0
    elif spec.get("dcs"):
        concurrent_declarations["dcs"] = spec["dcs"]
    if concurrent_declarations:
        # The pool is bounded by the DECLARED resource limits and by the budget
        # slice left on P6.1's clock — never by however many lanes exist.
        pool_plan = lane_pool_plan(list(concurrent_declarations))
        pool_states, pool_durations, pool_observations = execute_lane_pool(
            plan=pool_plan,
            declarations=dict(concurrent_declarations),
            execute=lambda kind, declaration: execute_lane(kind, declaration, pool_plan),
        )
        lane_observations.update(pool_observations)
        for kind in ("broker", "dcs"):
            if kind in pool_states:
                lanes[kind], lane_duration_ms[kind] = pool_states[kind], pool_durations[kind]
        for kind in pool_plan["order"]:
            lane_class = (pool_plan["lanes"].get(kind) or {}).get("priority_class", "mandatory")
            lane_summary = (pool_states.get(kind) or {}).get("summary") or {}
            lane_resource_receipts.append(compile_lane_resource_receipt(
                plan=pool_plan,
                kind=kind,
                grant=lane_grants[kind],
                observation=pool_observations[kind],
                # An optional lane that selected authority after structural
                # ownership was sealed, WITHOUT having been projected onto that
                # seal first, is a late enrichment against a sealed decision.
                late_enrichment_after_seal=bool(
                    lane_class == "optional"
                    and structural_seal_monotonic_ms is not None
                    and int(lane_summary.get("cell_count") or 0) > 0
                    and "broker_demand_ownership_projection" not in derived_artifacts
                ),
            ))
        flush_lane_resources()

    for kind in ("broker", "dcs"):
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
                    "lane_resource_receipts": lane_resource_receipts,
                    "broker_intake_state": broker_intake_choice.get("intake_state"),
                    "broker_and_debt_execution": "concurrent_after_filings",
                    "mandatory_lane_resume": "hash_bound_checkpoint_reuse" if reusable_mandatory_lanes else "fresh",
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
        semantic_recovery_started = time.monotonic()
        completed = run([
            NODE_EXECUTABLE, str(HERE / "compile_declared_evidence_run.mjs"), str(resolved_path),
            "--declarations", str(declarations_path), "--out", str(compiled_root),
        ])
        semantic_recovery_ms = max(
            0.001, round((time.monotonic() - semantic_recovery_started) * 1000, 3)
        )
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
                    "lane_resource_receipts": lane_resource_receipts,
                    "broker_intake_state": broker_intake_choice.get("intake_state"),
                    "broker_and_debt_execution": "concurrent_after_filings",
                    "mandatory_lane_resume": "hash_bound_checkpoint_reuse" if reusable_mandatory_lanes else "fresh",
                    "filings": (lanes.get("filings", {}).get("summary") or {}).get("performance", {}),
                    "semantic_recovery_ms": semantic_recovery_ms,
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
    try:
        _exit_code = main()
    except BaseException as _error:
        _finish_experience_trace(_error)
        _write_process_telemetry("FAIL")
        raise
    else:
        _terminal_error = None if _exit_code == 0 else RuntimeError(
            f"attachment evidence controller exited {_exit_code}"
        )
        _finish_experience_trace(_terminal_error)
        _write_process_telemetry("PASS" if _exit_code == 0 else "FAIL")
        raise SystemExit(_exit_code)
