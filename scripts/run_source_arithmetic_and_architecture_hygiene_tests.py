#!/usr/bin/env python3
"""Audit Excel Inflow architecture hygiene against the product target.

The filename intentionally places this test in the final clean-checkout gate's
non-vacuous source-arithmetic family. It does not mutate source. Any failure is
an earliest-owner or release-custody defect, not a workbook patch opportunity.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "audit" / "product-target-v1.json"
TEXT_SUFFIXES = {".py", ".mjs", ".js", ".cjs", ".json", ".md", ".yml", ".yaml"}
IGNORED = (".git/", "audit/generated/", "node_modules/")
PRIVATE_PATHS = ("/Users/", "/home/oai/", "/mnt/data/")
OLD_POLICY = "latest_supplied_house_then_zero_authority"
NEW_POLICY = "quality_ranked_native_then_one_recovery_frontier"
TEMPORARY_PATTERNS = (
    re.compile(r"^scripts/(?:apply_excel_inflow_repair|fix_stage|run_repair_stage|run_.*repair.*stage|.*stage.*repair|trigger_.*repair|.*repair.*launcher).+\.py$"),
    re.compile(r"^\.github/workflows/(?:patch-|.*orchestrator|final-repair|repair-workspace-export|repair-execution|cleanup-repair-scaffolding).+\.(?:yml|yaml)$"),
)


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def ignored(path: str) -> bool:
    return any(path.startswith(prefix) for prefix in IGNORED)


def load(path: Path) -> Any:
    return json.loads(path.read_text("utf-8"))


def strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from strings(item)


def registered_paths(value: Any) -> set[str]:
    result = set()
    for item in strings(value):
        if "/" in item and not item.startswith(("http://", "https://")):
            cleaned = item.split("#", 1)[0].strip()
            if cleaned and not any(token in cleaned for token in ("<", ">", "$", "*")):
                result.add(cleaned)
    return result


def main() -> int:
    checks = 0
    findings: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    try:
        target = load(TARGET)
    except Exception as error:
        findings.append({"code": "TARGET-MISSING", "path": rel(TARGET), "message": str(error)})
        target = {}
    checks += 1
    if target.get("schema_version") != "excel-inflow-product-target/1.0":
        findings.append({"code": "TARGET-SCHEMA", "path": rel(TARGET), "message": "Product target schema is absent or wrong."})

    text_by_path: dict[str, str] = {}
    json_by_path: dict[str, Any] = {}
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        relative = rel(path)
        if ignored(relative):
            continue
        if path.suffix.lower() in TEXT_SUFFIXES:
            text_by_path[relative] = path.read_text("utf-8", errors="ignore")
        if path.suffix.lower() == ".json":
            try:
                json_by_path[relative] = load(path)
            except Exception as error:
                findings.append({"code": "JSON-INVALID", "path": relative, "message": str(error)})
    checks += len(json_by_path)

    for relative in sorted(text_by_path):
        for pattern in TEMPORARY_PATTERNS:
            if pattern.match(relative):
                findings.append({"code": "TEMP-SCAFFOLD", "path": relative, "message": "One-off repair machinery survived cleanup."})
                break
    checks += 1

    for relative, text in text_by_path.items():
        if OLD_POLICY in text:
            findings.append({"code": "BROKER-OLD-POLICY", "path": relative, "message": OLD_POLICY})
        if not relative.startswith("audit/"):
            for token in PRIVATE_PATHS:
                if token in text:
                    findings.append({"code": "PRIVATE-PATH", "path": relative, "message": token})
    checks += 1
    new_policy_paths = [path for path, text in text_by_path.items() if NEW_POLICY in text]
    if not new_policy_paths:
        findings.append({"code": "BROKER-NEW-POLICY-MISSING", "path": "scripts/extract_broker_evidence.py", "message": NEW_POLICY})

    acquisition_docs = "\n".join(
        text_by_path.get(path, "").lower()
        for path in (
            "references/acquisition.md",
            "references/model-intent.md",
            "references/validation.md",
            "SKILL.md",
            "central-instructions.md",
        )
    )
    for phrase in (
        "zero direct transaction cash-flow effect",
        "no consideration row",
        "no financing-proceeds row",
    ):
        if phrase in acquisition_docs:
            findings.append({"code": "ACQ-CONTRADICTION", "path": "references", "message": phrase})
    for required in (
        "funded_transaction",
        "consideration",
        "acquisition debt",
        "financing proceeds",
    ):
        if required not in acquisition_docs:
            findings.append({"code": "ACQ-TARGET-MISSING", "path": "references/acquisition.md", "message": required})
    checks += 1

    registry = json_by_path.get("assets/development-test-registry.json")
    if not isinstance(registry, dict) or not isinstance(registry.get("tests"), list):
        findings.append({"code": "REGISTRY-MISSING", "path": "assets/development-test-registry.json", "message": "No test list."})
    else:
        ids = set()
        for entry in registry["tests"]:
            test_id = entry.get("id")
            script = entry.get("script")
            if not test_id or test_id in ids:
                findings.append({"code": "REGISTRY-ID", "path": "assets/development-test-registry.json", "message": str(test_id)})
            ids.add(test_id)
            if not script or not (ROOT / "scripts" / script).is_file():
                findings.append({"code": "REGISTRY-SCRIPT", "path": "assets/development-test-registry.json", "message": str(script)})
            arguments = entry.get("arguments") or []
            requires = set(entry.get("requires") or [])
            placeholders = {
                match.group(1)
                for argument in arguments
                for match in [re.fullmatch(r"\$([A-Z_]+)", str(argument))]
                if match
            }
            if placeholders != requires:
                findings.append({
                    "code": "REGISTRY-CUSTODY",
                    "path": "assets/development-test-registry.json",
                    "message": f"{test_id}: placeholders={sorted(placeholders)}, requires={sorted(requires)}",
                })
            if script == "run_universal_broker_delivery_matrix.mjs":
                resolved = [str(item) for item in arguments]
                if resolved != ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"] and resolved != ["$CLEAN_EVIDENCE_FIXTURE", "$PYTHON", "$SOFFICE"]:
                    findings.append({
                        "code": "REGISTRY-UNIVERSAL-MATRIX-CLI",
                        "path": "assets/development-test-registry.json",
                        "message": json.dumps(resolved),
                    })
        checks += len(registry["tests"])

    # Every explicit deployment/runtime member must exist. This catches stale
    # release ceremony and deleted-but-still-declared files.
    for relative, value in json_by_path.items():
        if not (
            relative.endswith("runtime-members.json")
            or relative in {"assets/deployment-profile.json", "release-manifest.json", "assets/runtime-manifest.json"}
        ):
            continue
        for candidate in sorted(registered_paths(value)):
            normalized = candidate.lstrip("./")
            if normalized.startswith(("assets/", "scripts/", "references/", ".github/")) and not (ROOT / normalized).exists():
                findings.append({"code": "DECLARED-PATH-MISSING", "path": relative, "message": normalized})
        checks += 1

    taxonomy = json_by_path.get("assets/statement-semantic-taxonomy.v1.json") or {}
    taxonomy_roles = {
        item.get("id") for item in taxonomy.get("roles", [])
        if isinstance(item, dict) and item.get("id")
    }
    high_impact = {
        item.get("id") for item in taxonomy.get("roles", [])
        if isinstance(item, dict) and item.get("high_impact") is True
    }
    behavior = text_by_path.get("scripts/lib/forecast_behavior.mjs", "")
    authority = text_by_path.get("scripts/lib/forecast_authority.mjs", "")
    producer = text_by_path.get("scripts/lib/forecast_producer_contract.mjs", "")
    semantic_runtime = "\n".join((behavior, authority, producer))
    if "acquisitions_net_of_cash" in taxonomy_roles and "acquisitions_net_of_cash" not in semantic_runtime:
        findings.append({
            "code": "ROLE-ORPHAN-ACQUISITION",
            "path": "assets/statement-semantic-taxonomy.v1.json",
            "message": "acquisitions_net_of_cash is not owned by forecast behavior/authority.",
        })
    for role in sorted(high_impact):
        if role not in semantic_runtime and role not in {"capex", "change_in_working_capital"}:
            warnings.append({"code": "ROLE-REVIEW", "path": "assets/statement-semantic-taxonomy.v1.json", "message": role})
    checks += len(taxonomy_roles)

    carrier = text_by_path.get("scripts/lib/run_carrier.mjs", "")
    for token in (
        "source_identity",
        "repository",
        "source_commit",
        "git_tree",
        "closure_sha256",
        "package_mode",
        "installation_identity",
    ):
        if token not in carrier:
            findings.append({"code": "CARRIER-IDENTITY", "path": "scripts/lib/run_carrier.mjs", "message": token})
    checks += 1

    canary = text_by_path.get("scripts/run_raw_input_black_box_canary.mjs", "")
    for token in (
        "coverage_ledger =",
        "mappings =",
        "preauthored_broker_crosswalk: false",
    ):
        if token in canary:
            findings.append({"code": "CANARY-FALSE-BOUNDARY", "path": "scripts/run_raw_input_black_box_canary.mjs", "message": token})
    checks += 1

    product = json_by_path.get("assets/product-constitution-v1.json") or {}
    milestones = product.get("visible_milestones")
    expected_milestones = target.get("visible_user_journey")
    if milestones != expected_milestones:
        findings.append({"code": "JOURNEY-DRIFT", "path": "assets/product-constitution-v1.json", "message": json.dumps(milestones)})
    checks += 1

    release = json_by_path.get("release-manifest.json") or {}
    certification = release.get("certification") or {}
    # A repair candidate remains explicitly development until native/host
    # evidence exists. Accidentally manufacturing a certified manifest in CI is
    # a release-governance defect.
    if release.get("packageMode") != "development":
        findings.append({"code": "RELEASE-MODE-PREMATURE", "path": "release-manifest.json", "message": str(release.get("packageMode"))})
    if certification.get("certifiedClosureSha256") and not certification.get("evidenceReceipt"):
        findings.append({"code": "RELEASE-CERT-VACUOUS", "path": "release-manifest.json", "message": "Certified closure lacks evidence receipt."})
    checks += 1

    large_files = []
    for path in ROOT.rglob("*"):
        if path.is_file() and not ignored(rel(path)) and path.suffix.lower() in {".py", ".mjs", ".js"}:
            size = path.stat().st_size
            if size > 250_000:
                large_files.append({"path": rel(path), "bytes": size})
    if large_files:
        warnings.append({"code": "LARGE-MODULES", "items": large_files})

    report = {
        "schema_version": "excel-inflow-architecture-hygiene/1.0",
        "status": "PASS" if not findings else "FAIL",
        "checks": checks,
        "finding_count": len(findings),
        "warning_count": len(warnings),
        "findings": findings,
        "warnings": warnings,
        "new_broker_policy_paths": sorted(new_policy_paths),
    }
    output = ROOT / "audit" / "generated" / "architecture-hygiene.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({
        "status": report["status"],
        "checks": checks,
        "findings": findings,
        "warnings": warnings,
        "report": rel(output),
    }, indent=2))
    return 0 if not findings else 1


if __name__ == "__main__":
    raise SystemExit(main())
