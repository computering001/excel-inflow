#!/usr/bin/env python3
"""Independent static audit of Excel Inflow's active source and policy surface.

This lint deliberately distinguishes release-blocking architectural drift from
maintainability debt.  It does not edit source, regenerate contracts, bless a
closure or treat warnings as product correctness.  The output is a deterministic
JSON receipt suitable for the development and release evidence graph.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {".py", ".mjs", ".js", ".cjs", ".json", ".md", ".yml", ".yaml"}
EXCLUDED_PARTS = {".git", "node_modules", "audit", "dist", "build", "__pycache__"}
REPAIR_PATTERNS = (
    "apply_excel_inflow_repair_stage",
    "run_repair_stage1_stage_v",
    "run_repair_stage2_stage_v",
    "fix_stage1_",
    "fix_stage2_",
)
LEGACY_BROKER_POLICY = "latest_supplied_house_then_zero_authority"
LEGACY_BLANKET_SUPPRESSION = (
    "archive-only regardless of whether its native lane happens to look complete"
)
ZERO_CASH_PHRASES = (
    "zero direct transaction cash-flow effect",
    "zero direct cash-flow effect",
    "no consideration row",
    "no financing-proceeds row",
    "no financing proceeds row",
)
PRIVATE_PATTERNS = (
    re.compile(r"/Users/[^/\s]+/"),
    re.compile(r"[A-Za-z]:\\Users\\[^\\\s]+\\"),
    re.compile(r"archiepjod(?:@gmail\.com)?", re.I),
)


def canonical(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    return value


def digest(value: Any) -> str:
    encoded = json.dumps(canonical(value), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def active_files() -> list[Path]:
    roots = [
        ROOT / "scripts",
        ROOT / "assets",
        ROOT / "references",
        ROOT / ".github" / "workflows",
    ]
    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            if any(part in EXCLUDED_PARTS for part in path.parts):
                continue
            files.append(path)
    for name in ("SKILL.md", "central-instructions.md", "release-manifest.json"):
        path = ROOT / name
        if path.is_file():
            files.append(path)
    return sorted(set(files))


def text(path: Path) -> str:
    return path.read_text("utf-8", errors="replace")


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def finding(code: str, severity: str, message: str, **details: Any) -> dict[str, Any]:
    return {"code": code, "severity": severity, "message": message, **details}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text("utf-8"))


def locate_role_registry() -> Path | None:
    candidates = [
        ROOT / "assets" / "semantic-role-registry-v2.json",
        ROOT / "assets" / "semantic-role-registry.json",
    ]
    return next((path for path in candidates if path.is_file()), None)


def role_ids(value: Any) -> set[str]:
    if not isinstance(value, dict):
        return set()
    rows = value.get("roles") or value.get("entries") or value.get("semantic_roles") or []
    if isinstance(rows, dict):
        rows = [
            ({"id": key, **entry} if isinstance(entry, dict) else {"id": key})
            for key, entry in rows.items()
        ]
    result = set()
    for row in rows:
        if isinstance(row, dict):
            identifier = row.get("id") or row.get("role_id") or row.get("semantic_role")
            if isinstance(identifier, str) and identifier:
                result.add(identifier)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    files = active_files()
    bodies = {path: text(path) for path in files}
    findings: list[dict[str, Any]] = []

    # Runtime portability and migration hygiene.
    for path, body in bodies.items():
        if path.resolve() == Path(__file__).resolve():
            continue
        relative = rel(path)
        for pattern in PRIVATE_PATTERNS:
            match = pattern.search(body)
            if match:
                findings.append(finding(
                    "PORTABILITY_PRIVATE_IDENTITY",
                    "BLOCK",
                    "Active source contains a private developer path or identity.",
                    path=relative,
                    match=match.group(0),
                ))
        if any(marker in path.name for marker in REPAIR_PATTERNS):
            findings.append(finding(
                "ONE_OFF_REPAIR_SCAFFOLDING",
                "BLOCK",
                "One-off migration code remains in the ordinary runtime tree.",
                path=relative,
            ))
        if LEGACY_BROKER_POLICY in body:
            findings.append(finding(
                "LEGACY_BROKER_POLICY",
                "BLOCK",
                "Publication-date-first broker recovery policy remains active.",
                path=relative,
            ))
        if LEGACY_BLANKET_SUPPRESSION in body:
            findings.append(finding(
                "LEGACY_NATIVE_HOUSE_SUPPRESSION",
                "BLOCK",
                "Native-clean unselected houses can still be prohibited before quality selection.",
                path=relative,
            ))

    # Product-spec closure for funded acquisition behavior.
    acquisition_paths = [
        ROOT / "references" / "acquisition.md",
        ROOT / "references" / "model-intent.md",
        ROOT / "references" / "validation.md",
    ]
    acquisition_text = "\n".join(text(path) for path in acquisition_paths if path.is_file()).lower()
    for phrase in ZERO_CASH_PHRASES:
        if phrase in acquisition_text:
            findings.append(finding(
                "ACQUISITION_ZERO_CASH_POLICY",
                "BLOCK",
                "The active acquisition specification still forbids funded transaction cash flows.",
                phrase=phrase,
            ))
    for required in ("consideration", "financing proceeds", "acquisition debt"):
        if required not in acquisition_text:
            findings.append(finding(
                "ACQUISITION_FUNDED_CONTRACT_INCOMPLETE",
                "BLOCK",
                "Funded acquisition policy omits a required economic concept.",
                concept=required,
            ))

    # False installed-host / black-box claims.
    canary = ROOT / "scripts" / "run_raw_input_local_semantic_canary.mjs"
    if canary.is_file():
        body = text(canary)
        semantic_authorship = any(marker in body for marker in (
            "coverage_ledger =",
            ".coverage_ledger =",
            ".mappings =",
            "definition_fingerprint =",
            "Simulate the installed model-host semantic response",
        ))
        claims_black_box = "black-box" in body.lower() or "black_box" in canary.name
        if semantic_authorship and claims_black_box:
            findings.append(finding(
                "FALSE_BLACK_BOX_HOST_BOUNDARY",
                "BLOCK",
                "A canary labelled black-box authors the semantic response it claims to test.",
                path=rel(canary),
            ))
        if semantic_authorship and "preauthored_broker_crosswalk: false" in body:
            findings.append(finding(
                "CANARY_RECEIPT_UNDERSTATES_AUTHORSHIP",
                "BLOCK",
                "Canary receipt denies pre-authorship while the harness writes semantic mappings.",
                path=rel(canary),
            ))

    # Registry interface integrity and non-vacuity ownership.
    registry_path = ROOT / "assets" / "development-test-registry.json"
    registry_tests: list[dict[str, Any]] = []
    if not registry_path.is_file():
        findings.append(finding(
            "TEST_REGISTRY_MISSING", "BLOCK", "Development test registry is absent."
        ))
    else:
        registry = load_json(registry_path)
        registry_tests = registry.get("tests") or []
        ids = [row.get("id") for row in registry_tests if isinstance(row, dict)]
        duplicates = sorted(identifier for identifier, count in Counter(ids).items() if identifier and count > 1)
        if duplicates:
            findings.append(finding(
                "TEST_REGISTRY_DUPLICATE_IDS",
                "BLOCK",
                "Test registry contains duplicate identifiers.",
                ids=duplicates,
            ))
        for row in registry_tests:
            if not isinstance(row, dict):
                continue
            script = ROOT / "scripts" / str(row.get("script") or "")
            if not script.is_file():
                findings.append(finding(
                    "TEST_REGISTRY_SCRIPT_MISSING",
                    "BLOCK",
                    "A registered test script is absent.",
                    test_id=row.get("id"),
                    script=row.get("script"),
                ))
        matrix = next((row for row in registry_tests if row.get("id") == "universal-broker-delivery-matrix"), None)
        if not matrix:
            findings.append(finding(
                "UNIVERSAL_MATRIX_UNREGISTERED",
                "BLOCK",
                "Universal broker delivery matrix is not in the development registry.",
            ))
        else:
            arguments=matrix.get("arguments") or []
            required={"$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"}
            if not required.issubset(set(arguments)):
                findings.append(finding(
                    "UNIVERSAL_MATRIX_INTERFACE_MISMATCH",
                    "BLOCK",
                    "Registry does not supply the matrix's current three required inputs.",
                    arguments=arguments,
                ))

        registered_names={
            f'{row.get("id") or ""} {row.get("script") or ""}'
            for row in registry_tests if isinstance(row, dict)
        }
        categories={
            "source_arithmetic": (("source", "arithmetic"), ("statement", "arithmetic"), ("filing", "arithmetic")),
            "discrete_event": (("discrete",), ("forecast", "behavior")),
            "broker_frontier": (("broker", "frontier"), ("broker", "demand"), ("broker", "selection")),
            "funded_acquisition": (("acquisition",),),
            "carrier_identity": (("carrier",), ("source", "identity")),
            "stage4_resume": (("stage4",), ("content", "addressed", "resume")),
        }
        for category,alternatives in categories.items():
            owned=any(
                all(token in name.lower() for token in tokens)
                for name in registered_names
                for tokens in alternatives
            )
            if not owned:
                findings.append(finding(
                    "TEST_CATEGORY_UNOWNED",
                    "BLOCK",
                    "A release-critical repaired behavior has no registered executable test.",
                    category=category,
                    expected_alternatives=[list(tokens) for tokens in alternatives],
                ))

    # Semantic role closure and discrete acquisition behavior.
    registry_role_path = locate_role_registry()
    roles: set[str] = set()
    role_registry_value: dict[str, Any] = {}
    if registry_role_path is None:
        findings.append(finding(
            "SEMANTIC_ROLE_REGISTRY_MISSING",
            "BLOCK",
            "No canonical semantic-role registry v2 is present.",
        ))
    else:
        role_registry_value = load_json(registry_role_path)
        roles = role_ids(role_registry_value)
        if "acquisitions_net_of_cash" not in roles:
            findings.append(finding(
                "ACQUISITION_ROLE_ORPHAN",
                "BLOCK",
                "The filing taxonomy acquisition role is absent from the canonical registry.",
                registry=rel(registry_role_path),
            ))
        taxonomy = ROOT / "assets" / "statement-semantic-taxonomy.v1.json"
        if taxonomy.is_file():
            taxonomy_roles = role_ids(load_json(taxonomy))
            missing = sorted(taxonomy_roles - roles)
            if missing:
                findings.append(finding(
                    "TAXONOMY_ROLE_NOT_IN_REGISTRY",
                    "BLOCK",
                    "Generated/legacy taxonomy emits roles outside the canonical registry.",
                    roles=missing,
                ))

    behavior = ROOT / "scripts" / "lib" / "forecast_behavior.mjs"
    candidate = ROOT / "scripts" / "lib" / "forecast_candidate_compiler.mjs"
    combined = "\n".join(text(path) for path in (behavior, candidate) if path.is_file())
    role_rows = (role_registry_value.get("roles") or role_registry_value.get("entries") or role_registry_value.get("semantic_roles") or [])
    if isinstance(role_rows, dict):
        role_rows = [
            ({"id": key, **entry} if isinstance(entry, dict) else {"id": key})
            for key, entry in role_rows.items()
        ]
    acquisition_role = next((row for row in role_rows if isinstance(row, dict) and (row.get("id") or row.get("role_id") or row.get("semantic_role")) == "acquisitions_net_of_cash"), None)
    acquisition_policy_text = json.dumps(acquisition_role or {}, sort_keys=True).lower()
    registry_declares_discrete = "discrete" in acquisition_policy_text or "non_recurring" in acquisition_policy_text or "non-recurring" in acquisition_policy_text
    if "acquisitions_net_of_cash" not in combined and not registry_declares_discrete:
        findings.append(finding(
            "DISCRETE_ACQUISITION_BEHAVIOR_UNBOUND",
            "BLOCK",
            "Neither generated role metadata nor an explicit consumer binds acquisitions_net_of_cash as a discrete event.",
        ))
    discrete_windows = re.findall(
        r"(?:discrete_event|non_recurring_event).{0,900}", combined, flags=re.I | re.S
    )
    if any("historical_average" in window or "historical_trend" in window or "carry_forward" in window for window in discrete_windows):
        findings.append(finding(
            "DISCRETE_EVENT_HISTORICAL_RECURRENCE",
            "BLOCK",
            "Discrete-event policy still exposes historical recurrence methods.",
        ))

    # Broker all-house native eligibility and bounded frontier policy.
    extractor = ROOT / "scripts" / "extract_broker_evidence.py"
    if extractor.is_file():
        body = text(extractor)
        if "quality_ranked_native_then_one_recovery_frontier" not in body:
            findings.append(finding(
                "BROKER_QUALITY_POLICY_MARKER_MISSING",
                "BLOCK",
                "Extractor does not declare the quality-ranked native-first policy.",
                path=rel(extractor),
            ))
        if re.search(
            r"unselected_house\s*=\s*descriptor\.get\([\"']house_id[\"']\)\s*!=\s*vision_house_id",
            body,
        ):
            findings.append(finding(
                "BROKER_EARLY_HOUSE_PROHIBITION",
                "BLOCK",
                "Extractor still derives model eligibility from the preselected recovery house.",
                path=rel(extractor),
            ))

    # Source arithmetic must be a first-class compiler artifact, not a caption regex.
    filing_extractor = ROOT / "scripts" / "extract_filing_statements.py"
    if filing_extractor.is_file():
        body = text(filing_extractor).lower()
        if not all(token in body for token in ("arithmetic", "reconcil", "historical")):
            findings.append(finding(
                "SOURCE_ARITHMETIC_COMPILER_MISSING",
                "BLOCK",
                "Filing extraction lacks a general historical arithmetic-reconciliation path.",
                path=rel(filing_extractor),
            ))
        issuer_pattern = re.search(
            r"re\.(?:search|match|fullmatch)\([^\n]{0,240}product\s+revenue",
            body,
        )
        if issuer_pattern:
            findings.append(finding(
                "ISSUER_SPECIFIC_AGGREGATION_BRANCH",
                "BLOCK",
                "Product Revenue is repaired through an issuer-caption regex instead of source arithmetic.",
                path=rel(filing_extractor),
            ))

    # A local simulated-semantic canary may never satisfy installed-host release evidence.
    release_paths = [
        ROOT / "scripts" / "compile_skill_release.mjs",
        ROOT / "scripts" / "validate_release_certification.mjs",
        ROOT / "scripts" / "lib" / "release_certification.mjs",
        ROOT / "scripts" / "orchestrate_release.mjs",
        ROOT / "assets" / "release-certification-evidence-v1.schema.json",
        ROOT / "release-manifest.json",
    ]
    release_body = "\n".join(text(item) for item in release_paths if item.is_file())
    for forbidden in (
        "run_raw_input_local_semantic_canary",
        "run_raw_input_black_box_canary",
        "raw-input-local-semantic-canary",
    ):
        if forbidden in release_body:
            findings.append(finding(
                "LOCAL_CANARY_USED_AS_RELEASE_HOST_PROOF",
                "BLOCK",
                "Release certification references a local simulated-semantic canary as evidence.",
                identifier=forbidden,
            ))
    normalized_release = re.sub(r"[^a-z0-9]+", "", release_body.lower())
    if release_body and not any(token in normalized_release for token in (
        "installedhost", "hostinstallation", "installedroute", "installreceipt"
    )):
        findings.append(finding(
            "INSTALLED_HOST_EVIDENCE_CONTRACT_MISSING",
            "BLOCK",
            "Release certification has no distinct installed-host/install-receipt evidence boundary.",
        ))

    # Run carrier must identify both source and installation state.
    carrier = ROOT / "scripts" / "lib" / "run_carrier.mjs"
    if carrier.is_file():
        body = text(carrier).lower()
        normalized = re.sub(r"[^a-z0-9]+", "", body)
        missing = [token for token in (
            "repository", "commit", "tree", "closure", "packagemode", "installation"
        ) if token not in normalized]
        if missing:
            findings.append(finding(
                "RUN_CARRIER_IDENTITY_INCOMPLETE",
                "BLOCK",
                "Run carrier omits immutable source or installation identity fields.",
                fields=missing,
                path=rel(carrier),
            ))

    # Maintainability register: visible, but not allowed to masquerade as correctness.
    line_counts = {rel(path): bodies[path].count("\n") + 1 for path in files}
    for path,count in sorted(line_counts.items(), key=lambda item: item[1], reverse=True):
        if count >= 4000:
            findings.append(finding(
                "OVERSIZED_ACTIVE_MODULE",
                "WARN",
                "Active module is large enough to obscure ownership and review boundaries.",
                path=path,
                lines=count,
            ))
    hashes: defaultdict[str, list[str]] = defaultdict(list)
    for path,body in bodies.items():
        if len(body) >= 5000:
            hashes[hashlib.sha256(body.encode()).hexdigest()].append(rel(path))
    for paths in hashes.values():
        if len(paths) > 1:
            findings.append(finding(
                "DUPLICATED_POLICY_TEXT",
                "WARN",
                "Large active files are byte-identical, creating parallel review surfaces.",
                paths=sorted(paths),
            ))
    for path,body in bodies.items():
        relative=rel(path)
        markers=len(re.findall(r"\b(?:TODO|FIXME|HACK|XXX)\b", body, flags=re.I))
        if markers:
            findings.append(finding(
                "OPEN_CODE_MARKERS",
                "WARN",
                "Active source contains unresolved maintenance markers.",
                path=relative,
                count=markers,
            ))
        if path.suffix == ".py":
            catches=len(re.findall(r"except\s+Exception(?:\s+as\s+\w+)?\s*:", body))
            if catches >= 5:
                findings.append(finding(
                    "CATCH_ALL_EXCEPTION_DENSITY",
                    "WARN",
                    "Module has a high density of catch-all exception boundaries; inspect ownership and receipts.",
                    path=relative,
                    count=catches,
                ))

    blockers=[row for row in findings if row["severity"] == "BLOCK"]
    warnings=[row for row in findings if row["severity"] == "WARN"]
    report={
        "schema_version":"excel-inflow-repository-forensic-lint/1.0",
        "status":"PASS" if not blockers else "FAIL",
        "root":str(ROOT),
        "active_file_count":len(files),
        "registered_test_count":len(registry_tests),
        "canonical_role_count":len(roles),
        "counts":{"blockers":len(blockers),"warnings":len(warnings)},
        "findings":findings,
    }
    report["report_sha256"] = digest(report)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({
        "status":report["status"],
        "blockers":len(blockers),
        "warnings":len(warnings),
        "report":str(out),
        "report_sha256":report["report_sha256"],
    }, sort_keys=True))
    return 0 if not blockers else 1


if __name__ == "__main__":
    raise SystemExit(main())
