#!/usr/bin/env python3
"""Blueprint-first forensic audit for Excel Inflow.

This script is intentionally read-only. It inventories the repository, maps the
implementation and test estate against the product contract, executes every
self-contained registered test, and emits machine-readable evidence. It never
changes source, expected outputs, schemas, release manifests or fixtures.
"""
from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {".md", ".mjs", ".js", ".py", ".json", ".yml", ".yaml", ".txt", ".csv"}
SOURCE_SUFFIXES = {".mjs", ".js", ".py"}

BLUEPRINT_REQUIREMENTS = [
    ("scope.debt_overlay", "Excel Inflow remains a company-specific 3H+3F corporate debt-overlay operating model, not a generic three-statement, ratings or valuation model."),
    ("scope.statement_depth", "Company-specific income-statement and cash-flow detail that explains cash, debt and leverage is preserved."),
    ("workbook.architecture", "Operating Model, Brokers and Forward Curves are the calculation-authority sheets; optional Bxx tabs are immutable screenshot evidence only."),
    ("workbook.geometry", "G:L is 3H+3F standalone, N:P acquisition adjustments, R:U latest historical/reference plus pro forma."),
    ("workbook.provenance", "Blue hardcodes, black formulas, green same-workbook links, no surviving external links, grey only for intentionally unavailable or inapplicable values."),
    ("economics.graph", "The declared economic equation graph, one forecast writer per node and the cash/RCF/interest fixed point remain strict."),
    ("economics.circularity", "Circularity off zeros model-generated forecast interest while debt, maturity, cash and RCF mechanics remain live."),
    ("economics.debt", "Instrument-period debt state, opening-debt reconciliation and debt/cash/RCF/lease/interest/liquidity/leverage identities remain strict."),
    ("journey.visible", "The only user-visible journey is Company -> Filings -> Brokers -> Debt -> Build -> Deliver."),
    ("journey.questions", "The user is asked only for material, unresolved, non-toggleable economic facts after deterministic fallbacks are exhausted."),
    ("broker.liveness", "Every optional broker failure still delivers when mandatory filings and debt evidence are valid."),
    ("broker.usefulness", "Readable, compatible broker evidence contributes forecast authority when it can materially improve the model."),
    ("broker.archive", "Every raw broker file and page image is preserved, while only exact verified selected cells may enter calculations."),
    ("broker.selection", "All houses receive cheap native inspection; coherent-house eligibility is quality-derived; at most one expensive recovery frontier opens afterward."),
    ("broker.demand", "Tier-1 demand includes revenue, EBIT/Adjusted EBITDA headline selection, D&A, effective tax rate, capex, working capital, dividends and buybacks when applicable."),
    ("filings.arithmetic", "Source-visible statement arithmetic owns aggregate relationships before taxonomy or forecast inference; labels are not the primary determinant."),
    ("forecast.nonrecurring", "Discrete acquisition, disposal, restructuring, litigation and similar events do not recur from historical averages without forward evidence."),
    ("acquisition.funded", "The lightweight acquisition case records consideration once, acquisition-debt proceeds once, persistent debt and coherent cash/RCF/interest/leverage effects."),
    ("validation.intent", "Tests prove economic intent and usefulness with non-vacuous mutations, not only conformance to a compiler-declared graph."),
    ("canary.host", "A usable-broker installed-host canary begins from raw PDFs and exercises the real model-host semantic seam without a pre-authored crosswalk."),
    ("runtime.telemetry", "Telemetry binds user submission, host work, controller spans and visible delivery under one run/trace identity."),
    ("runtime.performance", "Comparable normal production runs target 28-35 minutes; regressions are measured and bounded."),
    ("release.identity", "Every live run persists repository, commit, tree, closure, package mode, certification evidence and installed-package identity."),
    ("release.readiness", "Development identity, runtime delivery, PASS_PENDING_MANUAL and certified production readiness remain distinct states."),
    ("portability", "Repository-owned tests and normal runtime do not depend on a developer's absolute filesystem paths or hidden local fixtures."),
    ("maintainability", "The optional-evidence control plane is proportionate, has one state owner per concern and avoids duplicated constitutions that merely validate one another."),
]

@dataclass
class Finding:
    finding_id: str
    severity: str
    category: str
    symptom: str
    evidence: list[str]
    earliest_owner: str
    required_repair: str
    blocks_normal_use: bool = False
    blocks_promotion: bool = False


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def text(path: Path) -> str:
    try:
        return path.read_text("utf-8")
    except Exception:
        return ""


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def iter_files() -> list[Path]:
    ignored = {".git", "node_modules", "__pycache__", ".pytest_cache", "dist", "build"}
    return sorted(
        p for p in ROOT.rglob("*")
        if p.is_file() and not any(part in ignored for part in p.relative_to(ROOT).parts)
    )


def grep(pattern: str, files: list[Path], flags: int = 0) -> list[str]:
    rx = re.compile(pattern, flags)
    hits = []
    for path in files:
        content = text(path)
        for number, line in enumerate(content.splitlines(), 1):
            if rx.search(line):
                hits.append(f"{rel(path)}:{number}:{line.strip()[:240]}")
    return hits


def add(findings: list[Finding], *args: Any, **kwargs: Any) -> None:
    findings.append(Finding(*args, **kwargs))


def run(command: list[str], *, timeout: int = 300, cwd: Path = ROOT) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command, cwd=cwd, text=True, capture_output=True,
            timeout=timeout, check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        return {
            "command": command,
            "returncode": completed.returncode,
            "duration_ms": round((time.monotonic() - started) * 1000, 3),
            "stdout": completed.stdout[-20000:],
            "stderr": completed.stderr[-20000:],
            "status": "PASS" if completed.returncode == 0 else "FAIL",
        }
    except subprocess.TimeoutExpired as error:
        return {
            "command": command,
            "returncode": None,
            "duration_ms": round((time.monotonic() - started) * 1000, 3),
            "stdout": (error.stdout or "")[-20000:] if isinstance(error.stdout, str) else "",
            "stderr": (error.stderr or "")[-20000:] if isinstance(error.stderr, str) else "",
            "status": "TIMEOUT",
        }


def script_usage_contract(path: Path) -> dict[str, Any]:
    content = text(path)
    required_positionals = None
    if path.suffix in {".mjs", ".js"}:
        match = re.search(r"const\s*\[([^\]]+)\]\s*=\s*process\.argv\.slice\(2\)", content)
        if match:
            required_positionals = len([x for x in match.group(1).split(",") if x.strip()])
    if path.suffix == ".py":
        try:
            tree = ast.parse(content)
            required = 0
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "add_argument":
                    if node.args and isinstance(node.args[0], ast.Constant):
                        name = str(node.args[0].value)
                        if not name.startswith("-") and not any(
                            kw.arg in {"nargs"} and isinstance(kw.value, ast.Constant) and kw.value.value in {"?", "*"}
                            for kw in node.keywords
                        ):
                            required += 1
            required_positionals = required
        except SyntaxError:
            pass
    usage = re.findall(r"Usage:[^\n\"']+", content, re.I)
    return {"required_positionals": required_positionals, "usage": usage[:3]}


def registry_audit(files: list[Path], out: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    registry_path = ROOT / "assets/development-test-registry.json"
    registry = json.loads(registry_path.read_text("utf-8"))
    substitutions = {
        "CASES": None, "REPRESENTATIVE": None, "BROKER_CORPUS": None,
        "BROKER_REAL_PACK_MANIFEST": None, "FIXED_POINT_CASES_MANIFEST": None,
        "RAW_CANARY_EVIDENCE": None, "REAL_FILINGS_REQUEST": None,
        "REAL_FILINGS_EXPECTATIONS": None, "INSTALLED_HOST_BROKER_RECEIPT": None,
        "PYTHON": sys.executable, "SOFFICE": os.environ.get("SOFFICE"),
        "TEST_OUT": str(out / "test-output"),
    }
    rows = []
    results = []
    for item in registry.get("tests", []):
        script = ROOT / "scripts" / item["script"]
        requirements = item.get("requires", [])
        missing = [name for name in requirements if not substitutions.get(name)]
        args = []
        for raw in item.get("arguments", []):
            match = re.fullmatch(r"\$([A-Z_]+)", str(raw))
            args.append(substitutions.get(match.group(1)) if match else str(raw))
        interface = script_usage_contract(script) if script.exists() else {}
        supplied_positionals = len([x for x in args if x is not None and not str(x).startswith("-")])
        row = {
            "id": item.get("id"), "phase": item.get("phase"), "runtime": item.get("runtime"),
            "script": item.get("script"), "exists": script.exists(),
            "requires": requirements, "missing": missing,
            "arguments": item.get("arguments", []),
            "declared_required_positionals": interface.get("required_positionals"),
            "supplied_nonflag_arguments": supplied_positionals,
            "self_contained": not missing,
        }
        rows.append(row)
        if missing or not script.exists():
            results.append({"id": item.get("id"), "status": "BLOCKED", "missing": missing or ["SCRIPT"], "duration_ms": 0})
            continue
        command = [sys.executable if item.get("runtime") == "python" else "node", str(script)]
        command.extend(str(value) for value in args if value is not None)
        result = run(command, timeout=420)
        result["id"] = item.get("id")
        results.append(result)
    return rows, results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    files = iter_files()
    text_files = [p for p in files if p.suffix.lower() in TEXT_SUFFIXES]
    source_files = [p for p in files if p.suffix.lower() in SOURCE_SUFFIXES]
    findings: list[Finding] = []

    release = json.loads((ROOT / "release-manifest.json").read_text("utf-8"))
    runtime_manifest = json.loads((ROOT / "assets/runtime-manifest.json").read_text("utf-8")) if (ROOT / "assets/runtime-manifest.json").exists() else {}
    registry = json.loads((ROOT / "assets/development-test-registry.json").read_text("utf-8"))

    absolute_paths = grep(r"/(?:Users|home)/[A-Za-z0-9._-]+/", text_files)
    if absolute_paths:
        add(findings, "PORT-001", "P1", "portability", "Repository content contains developer-specific absolute paths.", absolute_paths[:80], "test and fixture custody", "Replace hidden machine paths with repository-owned fixtures or explicit required custody inputs.", True, True)

    acquisition_doc = text(ROOT / "references/acquisition.md")
    validation_doc = text(ROOT / "references/validation.md")
    if "zero direct transaction cash-flow effect" in acquisition_doc and "used once as consideration" in validation_doc:
        add(findings, "ACQ-001", "P1", "product_contract", "Acquisition product authority is contradictory: direct transaction cash is both forbidden and required.", ["references/acquisition.md", "references/validation.md"], "product specification", "Adopt one funded lightweight transaction contract and compile consideration, debt proceeds and residual cash/RCF funding once.", True, True)

    broker_doc = text(ROOT / "references/broker-extraction.md")
    extractor = text(ROOT / "scripts/extract_broker_evidence.py")
    if "Already clean native cells from other houses remain eligible" in broker_doc and "archive-only regardless of whether its" in extractor:
        add(findings, "BRK-001", "P1", "broker_authority", "Implementation suppresses native-clean non-selected houses before quality-derived coherent-house selection.", ["references/broker-extraction.md", "scripts/extract_broker_evidence.py"], "broker evidence eligibility", "Inspect all houses natively, rank coherent native coverage, then open at most one recovery frontier.", True, True)
    if "latest_supplied_house_then_zero_authority" in extractor:
        add(findings, "BRK-002", "P1", "broker_authority", "Publication date is embedded as the recovery/authority policy rather than a late tie-breaker.", ["scripts/extract_broker_evidence.py"], "broker recovery selection", "Rank material demanded coverage and verification quality first; publication date may break only a final tie.", True, True)

    canary = text(ROOT / "scripts/run_raw_input_black_box_canary.mjs")
    if "Simulate the installed model-host semantic response" in canary or ("zeroCrosswalk.coverage_ledger" in canary and "zeroCrosswalk.mappings" in canary):
        add(findings, "TST-001", "P1", "test_vacuity", "The raw-input canary manually authors the semantic response at the installed-host seam it claims to prove.", ["scripts/run_raw_input_black_box_canary.mjs"], "test harness", "Retain as a deterministic downstream fixture only and require a separate raw-PDF installed-host receipt for release certification.", False, True)

    behavior = text(ROOT / "scripts/lib/forecast_behavior.mjs")
    candidate = text(ROOT / "scripts/lib/forecast_candidate_compiler.mjs")
    taxonomy = text(ROOT / "assets/statement-semantic-taxonomy.v1.json")
    authority = text(ROOT / "scripts/lib/forecast_authority.mjs")
    if "acquisitions_net_of_cash" in taxonomy and "acquisitions_net_of_cash" not in behavior:
        add(findings, "FCT-001", "P1", "semantic_role_closure", "Taxonomy emits acquisitions_net_of_cash but forecast behavior does not own it as a discrete event.", ["assets/statement-semantic-taxonomy.v1.json", "scripts/lib/forecast_behavior.mjs"], "semantic role registry", "Close emitted/consumed role vocabulary and classify acquisitions_net_of_cash as a structured non-recurring event.", True, True)
    if "lumpy_discretionary_flow" in candidate and "three-year historical average used for a lumpy" in candidate:
        add(findings, "FCT-002", "P1", "forecast_policy", "The compiler explicitly repeats a three-year average for lumpy discretionary cash flow without forward evidence.", ["scripts/lib/forecast_candidate_compiler.mjs"], "forecast behavior policy", "Separate recurrence from variability; discrete events may not receive average/trend/carry authority.", True, True)

    filing_extractor = text(ROOT / "scripts/extract_filing_statements.py")
    if "def is_subtotal_label" in filing_extractor and "if row.get(\"is_subtotal\")" in filing_extractor and "series_sum" not in filing_extractor:
        add(findings, "FIL-001", "P1", "statement_topology", "Only label-approved rows can own filing children; source-visible arithmetic is not independently reconciled.", ["scripts/extract_filing_statements.py"], "filing source topology", "Infer unique geometry-and-value arithmetic over all three historical periods before taxonomy; labels remain secondary evidence.", True, True)

    product_revenue_tests = grep(r"Product Revenue|product_revenue|Product Sales\s*\+\s*Alliance Revenue", [p for p in source_files if "test" in p.name.lower()], re.I)
    if not product_revenue_tests:
        add(findings, "TST-002", "P1", "test_coverage", "No direct non-vacuous source-arithmetic regression protects the Product Revenue family.", [], "topology test estate", "Add relabel-stable, value-mutated arithmetic tests that fail when the parent edge is absent or wrong.", False, True)

    registry_entry = next((x for x in registry.get("tests", []) if x.get("id") == "universal-broker-delivery-matrix"), None)
    matrix_script = text(ROOT / "scripts/run_universal_broker_delivery_matrix.mjs")
    if registry_entry and "cleanFixtureArg, pythonArg, sofficeArg" in matrix_script and len(registry_entry.get("arguments", [])) != 3:
        add(findings, "TST-003", "P1", "test_interface", "The universal broker matrix registry invocation does not match the executable interface.", ["assets/development-test-registry.json", "scripts/run_universal_broker_delivery_matrix.mjs"], "test registry", "Bind the matrix to the raw canary fixture, Python and LibreOffice with an executable interface probe.", False, True)

    carrier = text(ROOT / "scripts/lib/run_carrier.mjs")
    identity_terms = ["source_commit", "source_tree", "package_mode", "certified_closure", "installation_identity"]
    missing_identity = [term for term in identity_terms if term not in carrier]
    if missing_identity:
        add(findings, "REL-001", "P1", "release_identity", "Run carrier does not persist enough source, certification and installation identity for live forensic reconstruction.", ["scripts/lib/run_carrier.mjs", f"missing={','.join(missing_identity)}"], "run carrier", "Add a versioned source/install identity block and reject production readiness when certification is absent or mismatched.", False, True)

    certification = release.get("certification", {})
    if release.get("packageMode") == "development" or not certification.get("certifiedClosureSha256"):
        add(findings, "REL-002", "P1", "release_governance", "The installed candidate is a development package without a certified closure or evidence receipt.", ["release-manifest.json"], "release routing", "Keep candidate delivery separate from production promotion and compile a new immutable certified release only after host/native/visual gates pass.", False, True)

    state_pair_hits = grep(r"ACTION_REQUIRED.{0,240}INTERNAL_WORK|INTERNAL_WORK.{0,240}ACTION_REQUIRED", source_files, re.I)
    if state_pair_hits:
        add(findings, "FLOW-001", "P1", "workflow_state", "Public ACTION_REQUIRED is paired with controller-owned INTERNAL_WORK in source, creating an invalid user boundary.", state_pair_hits[:40], "workflow state ownership", "Make internal work automatically resumable and reserve ACTION_REQUIRED for USER_DECISION/USER_EVIDENCE only.", True, True)

    broad_catches = grep(r"catch\s*\([^)]*\)\s*\{|except\s+Exception", source_files)
    silent_catches = grep(r"except\s+Exception\s*:\s*pass|catch\s*\([^)]*\)\s*\{\s*\}", source_files)
    if silent_catches:
        add(findings, "CODE-001", "P2", "error_handling", "Silent broad exception handlers can convert defects into stale or degraded state without custody.", silent_catches[:50], "error handling", "Replace with typed outcomes, bounded fallback and explicit receipts.", True, True)

    huge = []
    for path in source_files:
        lines = text(path).count("\n") + 1
        if lines >= 1200:
            huge.append(f"{rel(path)}:{lines}")
    if huge:
        add(findings, "CODE-002", "P2", "maintainability", "Several source modules are large enough to obscure ownership and make regression review unreliable.", sorted(huge, key=lambda x: int(x.rsplit(':',1)[1]), reverse=True)[:40], "module boundaries", "Extract pure policy owners and generated projections while preserving economic-engine boundaries.", False, False)

    constitution_files = [p for p in files if any(token in p.name for token in ("constitution", "state-contract", "runtime-members", "manifest"))]
    if len(constitution_files) >= 15:
        add(findings, "CODE-003", "P2", "architecture_complexity", "The control plane contains many overlapping constitutions, manifests and state contracts for a narrowly scoped product.", [rel(p) for p in constitution_files[:80]], "architecture", "Choose one product constitution, one workflow state machine and one executable authority contract; generate secondary views.", False, True)

    issuer_branches = grep(r"AstraZeneca|Berenberg|Kepler|BNP Paribas", source_files, re.I)
    if issuer_branches:
        add(findings, "CODE-004", "P2", "inflexibility", "Named issuer or broker strings appear in source and require review for production branching or fixture leakage.", issuer_branches[:60], "source generality", "Keep issuer/house names in fixtures only; production behavior must be definition-, geometry- and evidence-driven.", False, True)

    todo_hits = grep(r"\b(?:TODO|FIXME|HACK|XXX)\b", text_files, re.I)
    process_exit_hits = grep(r"process\.exit\s*\(|SystemExit\s*\(|sys\.exit\s*\(", source_files)
    direct_patch_hits = grep(r"patch.*cell|cell.*patch|terminal patch", source_files, re.I)

    json_results = []
    for path in [p for p in files if p.suffix == ".json"]:
        try:
            json.loads(path.read_text("utf-8"))
            json_results.append({"path": rel(path), "status": "PASS"})
        except Exception as error:
            json_results.append({"path": rel(path), "status": "FAIL", "error": str(error)})
            add(findings, "CODE-JSON", "P0", "syntax", "Repository JSON is invalid.", [f"{rel(path)}:{error}"], "source integrity", "Repair the malformed JSON before any other gate.", True, True)

    syntax_results = []
    for path in source_files:
        if path.suffix == ".py":
            result = run([sys.executable, "-m", "py_compile", str(path)], timeout=30)
        else:
            result = run(["node", "--check", str(path)], timeout=30)
        syntax_results.append({"path": rel(path), "status": result["status"], "stderr": result["stderr"][-2000:]})
        if result["status"] != "PASS":
            add(findings, "CODE-SYNTAX", "P0", "syntax", "Source file does not parse.", [f"{rel(path)}:{result['stderr'][-500:]}"], "source integrity", "Repair syntax before executing the gate.", True, True)

    registry_rows, test_results = registry_audit(files, out)
    failures = [x for x in test_results if x.get("status") in {"FAIL", "TIMEOUT"}]
    if failures:
        add(findings, "TST-004", "P1", "baseline_tests", "One or more self-contained registered tests fail or time out on the untouched candidate.", [f"{x['id']}:{x['status']}:{x.get('stderr','')[-500:]}" for x in failures[:40]], "test/runtime implementation", "Repair earliest production owners and retain targeted mutations; do not alter expectations to green the gate.", True, True)

    scripts = {p.name for p in (ROOT / "scripts").glob("run_*test*.*")}
    registered_scripts = {x.get("script") for x in registry.get("tests", [])}
    unregistered = sorted(scripts - registered_scripts)
    if unregistered:
        add(findings, "TST-005", "P2", "test_registry", "Runnable test scripts exist outside the development registry and therefore may silently rot.", unregistered[:100], "test registry", "Register, delete or explicitly classify each test as release-only diagnostic.", False, True)

    line_counts = {rel(p): text(p).count("\n") + 1 for p in text_files}
    suffix_counts = Counter(p.suffix.lower() or "<none>" for p in files)
    hashes = defaultdict(list)
    for path in files:
        hashes[sha256(path)].append(rel(path))
    duplicate_groups = [paths for paths in hashes.values() if len(paths) > 1]

    requirement_map = []
    finding_categories = defaultdict(list)
    for finding in findings:
        finding_categories[finding.category].append(finding.finding_id)
    heuristic = {
        "broker.liveness": "implemented_preserve",
        "broker.archive": "implemented_preserve",
        "economics.graph": "implemented_preserve",
        "economics.circularity": "implemented_preserve",
        "economics.debt": "implemented_preserve",
        "scope.debt_overlay": "implemented_preserve",
        "journey.visible": "partial",
        "broker.usefulness": "fails",
        "broker.selection": "fails",
        "broker.demand": "partial",
        "filings.arithmetic": "fails",
        "forecast.nonrecurring": "fails",
        "acquisition.funded": "fails",
        "validation.intent": "partial",
        "canary.host": "fails",
        "runtime.telemetry": "fails",
        "runtime.performance": "unproven",
        "release.identity": "fails",
        "release.readiness": "fails",
        "portability": "fails" if absolute_paths else "partial",
        "maintainability": "fails",
    }
    for requirement_id, requirement in BLUEPRINT_REQUIREMENTS:
        requirement_map.append({
            "requirement_id": requirement_id,
            "requirement": requirement,
            "baseline_status": heuristic.get(requirement_id, "partial"),
            "related_findings": [f.finding_id for f in findings if (
                requirement_id.split(".")[0] in f.category or
                (requirement_id.startswith("broker") and f.category.startswith("broker")) or
                (requirement_id.startswith("release") and f.category.startswith("release")) or
                (requirement_id.startswith("forecast") and f.category.startswith("forecast")) or
                (requirement_id.startswith("filings") and f.category.startswith("statement"))
            )],
        })

    report = {
        "schema_version": "excel-inflow-forensic-audit/1.0",
        "source": {
            "root": str(ROOT),
            "git_commit": os.environ.get("GITHUB_SHA") or run(["git", "rev-parse", "HEAD"], timeout=10)["stdout"].strip(),
            "file_count": len(files),
            "text_line_count": sum(line_counts.values()),
            "source_file_count": len(source_files),
            "json_file_count": sum(1 for p in files if p.suffix == ".json"),
            "suffix_counts": dict(suffix_counts),
            "release_name": release.get("releaseName"),
            "package_mode": release.get("packageMode"),
            "current_closure": certification.get("currentClosureSha256"),
            "certified_closure": certification.get("certifiedClosureSha256"),
            "runtime_manifest": runtime_manifest,
        },
        "blueprint_requirement_map": requirement_map,
        "findings": [asdict(f) for f in findings],
        "code_health": {
            "largest_files": sorted(line_counts.items(), key=lambda x: x[1], reverse=True)[:80],
            "duplicate_groups": duplicate_groups[:100],
            "broad_catch_count": len(broad_catches),
            "silent_catch_count": len(silent_catches),
            "process_exit_count": len(process_exit_hits),
            "direct_patch_reference_count": len(direct_patch_hits),
            "todo_count": len(todo_hits),
            "constitution_manifest_file_count": len(constitution_files),
            "absolute_path_count": len(absolute_paths),
            "unregistered_test_count": len(unregistered),
        },
        "syntax": syntax_results,
        "json_validation": json_results,
        "test_registry": registry_rows,
        "test_results": test_results,
        "summary": {
            "finding_counts": dict(Counter(f.severity for f in findings)),
            "normal_use_blocker_count": sum(f.blocks_normal_use for f in findings),
            "promotion_blocker_count": sum(f.blocks_promotion for f in findings),
            "self_contained_pass": sum(x.get("status") == "PASS" for x in test_results),
            "self_contained_fail": sum(x.get("status") in {"FAIL", "TIMEOUT"} for x in test_results),
            "custody_blocked": sum(x.get("status") == "BLOCKED" for x in test_results),
            "verdict": "DO_NOT_PROMOTE",
        },
    }
    (out / "forensic-audit.json").write_text(json.dumps(report, indent=2) + "\n", "utf-8")

    with (out / "blueprint-requirement-map.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["requirement_id", "requirement", "baseline_status", "related_findings"])
        writer.writeheader()
        for row in requirement_map:
            writer.writerow({**row, "related_findings": ";".join(row["related_findings"])})
    with (out / "finding-register.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(asdict(findings[0]).keys()) if findings else ["finding_id"])
        writer.writeheader()
        for finding in findings:
            row = asdict(finding)
            row["evidence"] = "\n".join(row["evidence"])
            writer.writerow(row)
    with (out / "test-results.csv").open("w", newline="", encoding="utf-8") as handle:
        fields = ["id", "status", "returncode", "duration_ms", "missing", "stderr"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for result in test_results:
            writer.writerow({
                "id": result.get("id"), "status": result.get("status"),
                "returncode": result.get("returncode"), "duration_ms": result.get("duration_ms"),
                "missing": ";".join(result.get("missing", [])),
                "stderr": result.get("stderr", "")[-4000:],
            })

    lines = [
        "# Excel Inflow blueprint-first forensic audit", "",
        f"**Verdict: {report['summary']['verdict']}**", "",
        f"Files: {len(files):,}; source files: {len(source_files):,}; text lines: {sum(line_counts.values()):,}.",
        f"Findings: {report['summary']['finding_counts']}; normal-use blockers: {report['summary']['normal_use_blocker_count']}; promotion blockers: {report['summary']['promotion_blocker_count']}.",
        f"Registered tests: {len(test_results)}; self-contained PASS {report['summary']['self_contained_pass']}; FAIL/TIMEOUT {report['summary']['self_contained_fail']}; custody BLOCKED {report['summary']['custody_blocked']}.", "",
        "## Blueprint mapping", "",
    ]
    for row in requirement_map:
        lines.append(f"- **{row['requirement_id']} — {row['baseline_status']}**: {row['requirement']}")
    lines.extend(["", "## Root-cause register", ""])
    for finding in findings:
        lines.extend([
            f"### {finding.finding_id} — {finding.severity} — {finding.symptom}", "",
            f"Earliest owner: **{finding.earliest_owner}**. Required repair: {finding.required_repair}", "",
            *[f"- `{item}`" for item in finding.evidence[:20]], "",
        ])
    (out / "forensic-audit.md").write_text("\n".join(lines) + "\n", "utf-8")

    print(json.dumps(report["summary"], sort_keys=True))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
