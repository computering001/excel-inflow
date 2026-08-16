#!/usr/bin/env python3
"""Run the final Excel Inflow repair gate from a clean archived checkout.

This gate is deliberately independent of the one-off repair launchers. It tests
only files present in the candidate source tree, discovers repository-owned
custody, invokes the registered internal test surface, and records every
command, input hash, duration and result. External real-corpus and installed-
host certification remain separate evidence and are never silently green.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

PRIVATE_PATH_PATTERNS = (
    re.compile(r"/Users/[^\s\"']+"),
    re.compile(r"/home/oai/[^\s\"']+"),
    re.compile(r"/mnt/data/[^\s\"']+"),
)
RUNTIME_SUFFIXES = {".py", ".mjs", ".js", ".cjs", ".json", ".md", ".yml", ".yaml"}
IGNORED_PREFIXES = (
    ".git/",
    "audit/generated/",
    "node_modules/",
)
OLD_BROKER_POLICY = "latest_supplied_house_then_zero_authority"
NEW_BROKER_POLICY = "quality_ranked_native_then_one_recovery_frontier"


def canonical(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    return value


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(canonical(value), indent=2, ensure_ascii=False) + "\n", "utf-8")


def relative(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def is_ignored(path: str) -> bool:
    return any(path.startswith(prefix) for prefix in IGNORED_PREFIXES)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text("utf-8"))


def command_record(
    root: Path,
    out: Path,
    test_id: str,
    command: list[str],
    *,
    timeout: int,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    started = time.time()
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **(environment or {})}
    try:
        completed = subprocess.run(
            command,
            cwd=root,
            text=True,
            capture_output=True,
            timeout=timeout,
            env=env,
            check=False,
        )
        status = "PASS" if completed.returncode == 0 else "FAIL"
        returncode = completed.returncode
        stdout = completed.stdout
        stderr = completed.stderr
    except subprocess.TimeoutExpired as error:
        status = "TIMEOUT"
        returncode = None
        stdout = error.stdout or ""
        stderr = error.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
    duration = time.time() - started
    record = {
        "id": test_id,
        "status": status,
        "command": command,
        "return_code": returncode,
        "duration_seconds": round(duration, 3),
        "stdout": stdout,
        "stderr": stderr,
    }
    write_json(out / "commands" / f"{test_id}.json", record)
    return record


def case_shape(value: Any) -> tuple[int, int, int] | None:
    if not isinstance(value, dict):
        return None
    periods = value.get("periods")
    structure = value.get("statement_structure")
    if not isinstance(periods, list) or len(periods) != 6 or not isinstance(structure, dict):
        return None
    income = structure.get("income_statement") or []
    cash = structure.get("cash_flow") or []
    instruments = value.get("instruments") or []
    if not isinstance(income, list) or not isinstance(cash, list) or not isinstance(instruments, list):
        return None
    return len(income), len(cash), len(instruments)


def discover_case_custody(root: Path, out: Path) -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    evidence: list[dict[str, Any]] = []
    manifests: list[dict[str, Any]] = []
    for path in root.rglob("*.json"):
        rel = relative(root, path)
        if is_ignored(rel):
            continue
        try:
            value = read_json(path)
        except Exception:
            continue
        shape = case_shape(value)
        if shape:
            reported_cash = value.get("reported_cash")
            reported_debt = value.get("reported_gross_debt")
            cases.append({
                "path": rel,
                "income_rows": shape[0],
                "cash_rows": shape[1],
                "instruments": shape[2],
                "reported_cash": reported_cash,
                "reported_gross_debt": reported_debt,
                "score": shape[0] + shape[1] + shape[2] * 2,
            })
        if isinstance(value, dict) and str(value.get("schema_version", "")).startswith("evidence-run/"):
            evidence.append({"path": rel, "sha256": sha256_file(path)})
        name = path.name.lower()
        if "fixed" in name and "point" in name and isinstance(value, dict):
            manifests.append({"path": rel, "sha256": sha256_file(path)})
    cases.sort(key=lambda item: (-item["score"], item["path"]))
    maximal = cases[0] if cases else None
    net_cash_candidates = [
        item for item in cases
        if isinstance(item.get("reported_cash"), (int, float))
        and isinstance(item.get("reported_gross_debt"), (int, float))
        and item["reported_cash"] >= item["reported_gross_debt"]
    ]
    net_cash = sorted(net_cash_candidates, key=lambda item: (-item["score"], item["path"]))[0] if net_cash_candidates else None
    candidate_directories: dict[str, int] = {}
    for item in cases:
        parent = str(Path(item["path"]).parent)
        candidate_directories[parent] = candidate_directories.get(parent, 0) + 1
    cases_directory = None
    if candidate_directories:
        cases_directory = sorted(candidate_directories.items(), key=lambda item: (-item[1], item[0]))[0][0]
    result = {
        "case_count": len(cases),
        "cases_directory": cases_directory,
        "representative_maximal": maximal,
        "representative_net_cash": net_cash,
        "evidence_runs": evidence,
        "fixed_point_manifests": manifests,
        "cases": cases,
    }
    write_json(out / "case-custody.json", result)
    return result


def static_audit(root: Path, out: Path) -> dict[str, Any]:
    json_failures: list[dict[str, str]] = []
    private_paths: list[dict[str, Any]] = []
    old_policy_hits: list[dict[str, Any]] = []
    new_policy_hits: list[str] = []
    authored_semantic_boundary_hits: list[dict[str, Any]] = []
    acquisition_zero_cash_hits: list[dict[str, Any]] = []
    source_files = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = relative(root, path)
        if is_ignored(rel):
            continue
        if path.suffix.lower() == ".json":
            try:
                read_json(path)
            except Exception as error:
                json_failures.append({"path": rel, "error": str(error)})
        if path.suffix.lower() not in RUNTIME_SUFFIXES:
            continue
        source_files += 1
        text = path.read_text("utf-8", errors="ignore")
        if OLD_BROKER_POLICY in text:
            old_policy_hits.append({"path": rel, "line_count": text.count(OLD_BROKER_POLICY)})
        if NEW_BROKER_POLICY in text:
            new_policy_hits.append(rel)
        if not rel.startswith("audit/"):
            for pattern in PRIVATE_PATH_PATTERNS:
                matches = sorted(set(pattern.findall(text)))
                if matches:
                    private_paths.append({"path": rel, "matches": matches[:20]})
        if path.name == "run_raw_input_black_box_canary.mjs":
            forbidden = [
                "coverage_ledger =",
                "mappings =",
                "model_use = \"active_input\"",
                "preauthored_broker_crosswalk: false",
            ]
            for token in forbidden:
                if token in text:
                    authored_semantic_boundary_hits.append({"path": rel, "token": token})
        if rel in {"references/acquisition.md", "references/model-intent.md"}:
            for phrase in (
                "zero direct transaction cash-flow effect",
                "no consideration row",
                "no financing-proceeds row",
            ):
                if phrase in text.lower():
                    acquisition_zero_cash_hits.append({"path": rel, "phrase": phrase})
    target = root / "audit" / "product-target-v1.json"
    target_valid = False
    target_error = None
    try:
        target_value = read_json(target)
        target_valid = target_value.get("schema_version") == "excel-inflow-product-target/1.0"
        if not target_valid:
            target_error = "wrong schema_version"
    except Exception as error:
        target_error = str(error)
    carrier = root / "scripts" / "lib" / "run_carrier.mjs"
    carrier_text = carrier.read_text("utf-8", errors="ignore") if carrier.is_file() else ""
    carrier_identity_tokens = {
        token: token in carrier_text
        for token in (
            "source_identity",
            "repository",
            "source_commit",
            "git_tree",
            "closure_sha256",
            "package_mode",
            "installation_identity",
        )
    }
    result = {
        "source_file_count": source_files,
        "json_failures": json_failures,
        "private_path_hits": private_paths,
        "old_broker_policy_hits": old_policy_hits,
        "new_broker_policy_paths": sorted(set(new_policy_hits)),
        "raw_canary_authored_semantic_boundary_hits": authored_semantic_boundary_hits,
        "acquisition_zero_cash_policy_hits": acquisition_zero_cash_hits,
        "product_target_valid": target_valid,
        "product_target_error": target_error,
        "carrier_identity_tokens": carrier_identity_tokens,
    }
    result["status"] = "PASS" if (
        not json_failures
        and not private_paths
        and not old_policy_hits
        and not authored_semantic_boundary_hits
        and not acquisition_zero_cash_hits
        and target_valid
        and all(carrier_identity_tokens.values())
    ) else "FAIL"
    write_json(out / "static-audit.json", result)
    return result


def find_first_existing(root: Path, paths: list[str]) -> Path | None:
    for rel in paths:
        target = root / rel
        if target.is_file():
            return target
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--out", required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--soffice", default=shutil.which("soffice") or "")
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    args = parser.parse_args()

    root = Path(args.root).resolve()
    out = Path(args.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    if not (root / "SKILL.md").is_file() or not (root / "release-manifest.json").is_file():
        raise SystemExit(f"Not an Excel Inflow source root: {root}")

    static = static_audit(root, out)
    custody = discover_case_custody(root, out)
    python = str(Path(args.python).resolve()) if Path(args.python).exists() else args.python
    soffice = str(Path(args.soffice).resolve()) if args.soffice and Path(args.soffice).exists() else args.soffice
    cases_dir = root / custody["cases_directory"] if custody.get("cases_directory") else None
    representative = root / custody["representative_maximal"]["path"] if custody.get("representative_maximal") else None
    fixed_manifest = root / custody["fixed_point_manifests"][0]["path"] if custody.get("fixed_point_manifests") else None
    raw_evidence = root / custody["evidence_runs"][0]["path"] if custody.get("evidence_runs") else None

    env = {"EXCEL_INFLOW_TEST_PYTHON": python}
    records: list[dict[str, Any]] = []
    required_commands: list[tuple[str, list[str], int]] = []

    exact_no_arg = [
        "run_product_constitution_tests.mjs",
        "run_delivery_constitution_tests.mjs",
        "run_run_constitution_graph_tests.mjs",
        "run_equation_graph_tests.mjs",
        "run_instrument_period_state_tests.mjs",
        "run_opening_debt_reconciliation_tests.mjs",
        "run_forecast_behavior_tests.mjs",
        "run_forecast_topology_tests.mjs",
        "run_historical_normalisation_tests.mjs",
        "run_filings_pipeline_tests.mjs",
        "run_workflow_state_tests.mjs",
        "run_user_flow_tests.mjs",
        "run_case_authorship_boundary_tests.mjs",
        "run_controller_exit_inventory_tests.mjs",
        "run_broker_preview_tests.mjs",
        "run_broker_exit_fault_injection_tests.mjs",
        "run_broker_demand_selection_tests.py",
        "run_broker_degraded_close_tests.py",
        "run_broker_house_exclusion_tests.py",
        "run_broker_selected_cell_recovery_tests.py",
        "run_broker_physical_reconciliation_tests.py",
        "run_broker_period_header_tests.py",
        "run_broker_table_engine_tests.py",
        "run_evidence_pipeline_tests.py",
        "run_internal_fixed_point_tests.py",
    ]
    for filename in exact_no_arg:
        path = root / "scripts" / filename
        if not path.is_file():
            continue
        runtime = python if path.suffix == ".py" else shutil.which("node") or "node"
        required_commands.append((path.stem, [runtime, str(path)], args.timeout_seconds))

    # Any repair-specific non-vacuous tests are required when present.
    keywords = (
        "source_arithmetic",
        "statement_arithmetic",
        "discrete_event",
        "broker_frontier",
        "native_house",
        "funded_acquisition",
        "acquisition_funding",
        "headline_authority",
        "carrier_identity",
    )
    selected_paths: set[Path] = set()
    for path in (root / "scripts").glob("*test*"):
        lowered = path.name.lower()
        if path.is_file() and any(keyword in lowered for keyword in keywords):
            selected_paths.add(path)
    already = {Path(command[1][1]).resolve() for command in required_commands if len(command[1]) > 1}
    for path in sorted(selected_paths):
        if path.resolve() in already:
            continue
        runtime = python if path.suffix == ".py" else shutil.which("node") or "node"
        required_commands.append((path.stem, [runtime, str(path)], args.timeout_seconds))

    if representative:
        for filename in (
            "run_statement_classifier_tests.mjs",
            "run_layered_graph_constitution_tests.mjs",
            "run_broker_page_evidence_tests.mjs",
        ):
            path = root / "scripts" / filename
            if path.is_file():
                required_commands.append((path.stem, [shutil.which("node") or "node", str(path), str(representative)], args.timeout_seconds))

    if cases_dir and cases_dir.is_dir():
        for filename in (
            "run_case_compiler_equivalence.mjs",
            "run_evidence_run_tests.mjs",
            "run_degraded_broker_delivery_tests.mjs",
        ):
            path = root / "scripts" / filename
            if path.is_file():
                required_commands.append((path.stem, [shutil.which("node") or "node", str(path), str(cases_dir)], args.timeout_seconds))
        stage4 = root / "scripts" / "run_stage4_checkpoint_tests.mjs"
        if stage4.is_file() and soffice:
            required_commands.append((
                stage4.stem,
                [shutil.which("node") or "node", str(stage4), "--cases", str(cases_dir), "--python", python, "--soffice", soffice],
                max(args.timeout_seconds, 2400),
            ))

    if fixed_manifest:
        path = root / "scripts" / "run_fixed_point_constitution_tests.mjs"
        if path.is_file():
            required_commands.append((path.stem, [shutil.which("node") or "node", str(path), "--manifest", str(fixed_manifest)], args.timeout_seconds))

    # Run the source-owned registry over internal phases. This is intentionally
    # additional to direct critical tests: it catches a listed-but-unexecuted or
    # argument-contract defect in the registry itself.
    development_gate = root / "scripts" / "run_development_gate.mjs"
    if development_gate.is_file() and cases_dir and representative and soffice:
        command = [
            shutil.which("node") or "node",
            str(development_gate),
            "--phase", "graph,workflow,evidence,forecast,economics,cohort,proof",
            "--cases", str(cases_dir),
            "--representative", str(representative),
            "--python", python,
            "--soffice", soffice,
            "--out", str(out / "development-gate"),
            "--concurrency", "2",
            "--timeout-ms", str(max(args.timeout_seconds, 1800) * 1000),
        ]
        if fixed_manifest:
            command += ["--fixed-point-cases-manifest", str(fixed_manifest)]
        if raw_evidence:
            command += ["--raw-canary-evidence", str(raw_evidence)]
        required_commands.append(("development_gate_internal", command, max(args.timeout_seconds, 3600)))

    seen_ids: set[str] = set()
    for test_id, command, timeout in required_commands:
        base_id = re.sub(r"[^a-zA-Z0-9_.-]+", "_", test_id)
        unique_id = base_id
        suffix = 2
        while unique_id in seen_ids:
            unique_id = f"{base_id}_{suffix}"
            suffix += 1
        seen_ids.add(unique_id)
        records.append(command_record(root, out, unique_id, command, timeout=timeout, environment=env))

    missing_custody = []
    if not cases_dir:
        missing_custody.append("repository_owned_case_directory")
    if not representative:
        missing_custody.append("representative_maximal_case")
    if not fixed_manifest:
        missing_custody.append("fixed_point_cases_manifest")
    if not raw_evidence:
        missing_custody.append("raw_canary_evidence")
    if not soffice:
        missing_custody.append("libreoffice")

    failures = [record for record in records if record["status"] != "PASS"]
    summary = {
        "schema_version": "excel-inflow-final-clean-checkout-gate/1.0",
        "status": "PASS" if static["status"] == "PASS" and not missing_custody and not failures else "FAIL",
        "source_root": str(root),
        "source_tree_digest": sha256_bytes("\n".join(
            f"{relative(root, path)}\0{sha256_file(path)}"
            for path in sorted(root.rglob("*"))
            if path.is_file() and not is_ignored(relative(root, path))
        ).encode("utf-8")),
        "static_status": static["status"],
        "missing_required_custody": missing_custody,
        "test_count": len(records),
        "pass_count": sum(record["status"] == "PASS" for record in records),
        "fail_count": len(failures),
        "failures": [
            {
                "id": record["id"],
                "status": record["status"],
                "return_code": record["return_code"],
                "duration_seconds": record["duration_seconds"],
                "stderr_tail": record["stderr"][-4000:],
                "stdout_tail": record["stdout"][-4000:],
            }
            for record in failures
        ],
        "external_certification_not_claimed": [
            "real_multi_house_public_layout_corpus",
            "real_reviewed_broker_pack",
            "installed_host_semantic_authoring",
            "native_excel_toggle_restoration",
            "human_visual_review",
            "joined_end_user_performance_cohort",
            "certified_release_closure_and_install_route",
        ],
    }
    write_json(out / "final-clean-checkout-gate.json", summary)
    markdown = [
        "# Excel Inflow final clean-checkout gate",
        "",
        f"**Status:** `{summary['status']}`",
        "",
        f"- Tests: {summary['pass_count']} passed / {summary['test_count']} executed",
        f"- Static audit: {summary['static_status']}",
        f"- Missing custody: {', '.join(missing_custody) if missing_custody else 'none'}",
        "",
    ]
    if failures:
        markdown += ["## Failures", ""]
        for failure in summary["failures"]:
            markdown += [
                f"### {failure['id']} — {failure['status']}",
                "",
                "```text",
                failure["stderr_tail"] or failure["stdout_tail"],
                "```",
                "",
            ]
    markdown += [
        "## Certification boundaries not claimed by this local gate",
        "",
        *[f"- {item}" for item in summary["external_certification_not_claimed"]],
        "",
    ]
    (out / "final-clean-checkout-gate.md").write_text("\n".join(markdown), "utf-8")
    print(json.dumps({
        "status": summary["status"],
        "tests": summary["test_count"],
        "passed": summary["pass_count"],
        "missing_custody": missing_custody,
        "failures": [item["id"] for item in failures],
        "report": str(out / "final-clean-checkout-gate.json"),
    }, indent=2))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
