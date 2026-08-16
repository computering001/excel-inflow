#!/usr/bin/env python3
"""Issue the final repository-candidate verdict after all portable gates."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_PATH = re.compile(r"/(?:Users|home|Volumes|private/tmp|var/folders)/[^\s\"'`]+")
SOURCE_SUFFIXES = {".py", ".mjs", ".js", ".cjs", ".json", ".md", ".yml", ".yaml"}


def git(*args: str) -> str:
    completed = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True, check=False)
    return completed.stdout.strip()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text("utf-8"))
    if not isinstance(value, dict):
        raise AssertionError(f"Expected JSON object at {path}")
    return value


def path_findings() -> list[dict[str, Any]]:
    findings = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SOURCE_SUFFIXES:
            continue
        relative = path.relative_to(ROOT).as_posix()
        if ".git" in path.parts or "node_modules" in path.parts or relative.startswith("audit/generated/"):
            continue
        # Historical audit reports may quote old absolute paths; executable
        # sources, schemas, current docs and workflows may not own them.
        for number, line in enumerate(path.read_text("utf-8", errors="ignore").splitlines(), 1):
            for match in FORBIDDEN_PATH.finditer(line):
                findings.append({"path": relative, "line": number, "value": match.group(0)})
    return findings


def source_contract_checks() -> list[dict[str, Any]]:
    files = {
        "broker": (ROOT / "scripts" / "extract_broker_evidence.py").read_text("utf-8"),
        "filings": (ROOT / "scripts" / "extract_filing_statements.py").read_text("utf-8"),
        "behavior": (ROOT / "scripts" / "lib" / "forecast_behavior.mjs").read_text("utf-8"),
        "authority": (ROOT / "scripts" / "lib" / "forecast_authority.mjs").read_text("utf-8"),
        "carrier": (ROOT / "scripts" / "lib" / "run_carrier.mjs").read_text("utf-8"),
        "canary": (ROOT / "scripts" / "run_raw_input_black_box_canary.mjs").read_text("utf-8"),
        "acquisition": (ROOT / "references" / "acquisition.md").read_text("utf-8"),
        "validation": (ROOT / "references" / "validation.md").read_text("utf-8"),
    }
    registry = read_json(ROOT / "assets" / "development-test-registry.json")
    universal = next((item for item in registry.get("tests", []) if item.get("id") == "universal-broker-delivery-matrix"), {})
    checks = [
        {
            "id": "broker_native_before_recovery",
            "pass": "archive-only regardless of whether its" not in files["broker"]
                    and "unselected_house_recovery" in files["broker"]
                    and "quality_ranked_native_then_one_recovery_frontier" in files["broker"],
        },
        {
            "id": "tier1_demand_complete",
            "pass": all(label in files["broker"] for label in [
                "Adjusted EBITDA", "Depreciation and amortisation", "Effective tax rate",
                "Capital expenditure", "Change in working capital", "Dividends paid", "Share buybacks",
            ]),
        },
        {
            "id": "source_arithmetic_before_taxonomy",
            "pass": "def infer_arithmetic_parent_links" in files["filings"]
                    and files["filings"].find("infer_arithmetic_parent_links(rows)") < files["filings"].find("infer_parent_links(rows)"),
        },
        {
            "id": "discrete_acquisition_role_closed",
            "pass": "acquisitions_net_of_cash" in files["behavior"]
                    and "acquisitions_net_of_cash" in files["authority"],
        },
        {
            "id": "funded_acquisition_doctrine",
            "pass": "consideration cash flow" in files["acquisition"]
                    and "acquisition debt proceeds" in files["acquisition"]
                    and "zero direct transaction cash-flow effect" not in files["acquisition"]
                    and "transaction value is used once as consideration" in files["validation"],
        },
        {
            "id": "carrier_source_identity",
            "pass": "debt-model-run-carrier/3.0" in files["carrier"]
                    and "source_identity_hash" in files["carrier"]
                    and "GIT_OBJECT" in files["carrier"],
        },
        {
            "id": "canary_claim_is_honest",
            "pass": "installed_host_semantic_seam_exercised: false" in files["canary"]
                    and "installed_host_certification_claim: false" in files["canary"]
                    and "test_authored_fixture" in files["canary"],
        },
        {
            "id": "universal_matrix_interface",
            "pass": universal.get("arguments") == ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]
                    and universal.get("requires") == ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"],
        },
    ]
    return checks


def code_quality() -> dict[str, Any]:
    modules = []
    broad_handlers = []
    unchecked_processes = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".py", ".mjs", ".js", ".cjs"}:
            continue
        relative = path.relative_to(ROOT).as_posix()
        if relative.startswith("audit/generated/") or ".git" in path.parts:
            continue
        text = path.read_text("utf-8", errors="ignore")
        lines = text.splitlines()
        if len(lines) >= 800:
            modules.append({"path": relative, "lines": len(lines), "bytes": path.stat().st_size})
        for number, line in enumerate(lines, 1):
            if path.suffix == ".py" and re.search(r"except\s+(?:Exception|BaseException)(?:\s+as\s+\w+)?\s*:", line):
                broad_handlers.append({"path": relative, "line": number})
            if "check=False" in line or "check = False" in line:
                unchecked_processes.append({"path": relative, "line": number})
    return {
        "oversized_modules": sorted(modules, key=lambda item: -item["lines"]),
        "broad_handler_count": len(broad_handlers),
        "unchecked_subprocess_count": len(unchecked_processes),
        "broad_handlers": broad_handlers,
        "unchecked_processes": unchecked_processes,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--portable-e2e", required=True)
    parser.add_argument("--stage1", required=True)
    parser.add_argument("--stage2", required=True)
    parser.add_argument("--acquisition", required=True)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    evidence = {
        "stage1": read_json(Path(args.stage1)),
        "stage2": read_json(Path(args.stage2)),
        "acquisition": read_json(Path(args.acquisition)),
        "portable_e2e": read_json(Path(args.portable_e2e)),
    }
    evidence_status = {
        key: value.get("status") == "PASS" for key, value in evidence.items()
    }
    source_checks = source_contract_checks()
    portability = path_findings()
    release = read_json(ROOT / "release-manifest.json")
    certification = release.get("certification") or {}
    repository_ready = (
        all(evidence_status.values())
        and all(item["pass"] for item in source_checks)
        and not portability
    )
    external_conditions = [
        {
            "id": "installed_host_usable_broker",
            "required": True,
            "satisfied": False,
            "evidence": "installed-host-broker-canary/1.0 receipt from the live Rogo model host, with no pre-authored semantic response and verified workbook broker links",
        },
        {
            "id": "native_excel_restoration",
            "required": True,
            "satisfied": False,
            "evidence": "native-excel-restoration-evidence/3.1 for off/on/off/on circularity and acquisition toggles",
        },
        {
            "id": "human_visual_review",
            "required": True,
            "satisfied": False,
            "evidence": "hash-bound rendered workbook pages and reviewed native workbook",
        },
        {
            "id": "installed_host_wall_clock_cohort",
            "required": True,
            "satisfied": False,
            "evidence": "submission-to-visible-response traces for comparable three-broker/one-DCS runs, with p50 <=35m, p95 <=45m and >=98% attribution",
        },
    ]
    package_is_certified = (
        release.get("packageMode") != "development"
        and isinstance(certification.get("certifiedClosureSha256"), str)
        and bool(certification.get("evidenceReceipt"))
    )
    candidate_status = (
        "REPOSITORY_CANDIDATE_READY_FOR_HOST_VALIDATION"
        if repository_ready
        else "REPAIR_FAILED"
    )
    promotion = (
        "PROMOTE_ONLY_AFTER_NAMED_EXTERNAL_CONDITIONS"
        if repository_ready and not package_is_certified
        else "DO_NOT_PROMOTE"
    )
    report = {
        "schema_version": "excel-inflow-final-candidate-audit/1.0",
        "candidate_status": candidate_status,
        "promotion_recommendation": promotion,
        "source_identity": {
            "head_commit_before_final_commit": git("rev-parse", "HEAD"),
            "head_tree_before_final_commit": git("rev-parse", "HEAD^{tree}"),
            "working_tree_diff_sha256": hashlib.sha256(git("diff", "--binary").encode()).hexdigest(),
        },
        "product_target_sha256": hashlib.sha256((ROOT / "audit" / "product-target-v1.json").read_bytes()).hexdigest(),
        "repository_evidence_status": evidence_status,
        "source_contract_checks": source_checks,
        "portability_findings": portability,
        "code_quality": code_quality(),
        "portable_e2e_report_sha256": evidence["portable_e2e"].get("report_sha256"),
        "installed_host_semantic_seam_exercised": False,
        "external_release_conditions": external_conditions,
        "release_manifest": {
            "package_mode": release.get("packageMode"),
            "current_closure_sha256": certification.get("currentClosureSha256"),
            "certified_closure_sha256": certification.get("certifiedClosureSha256"),
            "evidence_receipt": certification.get("evidenceReceipt"),
        },
        "package_is_certified": package_is_certified,
    }
    report["report_sha256"] = hashlib.sha256((json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()).hexdigest()
    (output / "final-candidate-audit.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    with (output / "final-candidate-audit.md").open("w", encoding="utf-8") as handle:
        handle.write("# Excel Inflow final candidate audit\n\n")
        handle.write(f"- Candidate status: **{candidate_status}**\n")
        handle.write(f"- Promotion recommendation: **{promotion}**\n")
        handle.write(f"- Report SHA-256: `{report['report_sha256']}`\n")
        handle.write(f"- Package mode: `{release.get('packageMode')}`\n")
        handle.write(f"- Installed-host usable-broker seam exercised: **no**\n\n")
        handle.write("## Repository evidence\n\n")
        for key, value in evidence_status.items():
            handle.write(f"- {key}: {'PASS' if value else 'FAIL'}\n")
        handle.write("\n## Source contract checks\n\n")
        for item in source_checks:
            handle.write(f"- {item['id']}: {'PASS' if item['pass'] else 'FAIL'}\n")
        handle.write("\n## Named external promotion conditions\n\n")
        for item in external_conditions:
            handle.write(f"- **{item['id']}** — {item['evidence']}\n")
        handle.write("\nThe repository candidate is not labelled certified merely because portable workbooks deliver.\n")
    print(json.dumps({"candidate_status": candidate_status, "promotion_recommendation": promotion, "report_sha256": report["report_sha256"]}, sort_keys=True))
    return 0 if repository_ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
