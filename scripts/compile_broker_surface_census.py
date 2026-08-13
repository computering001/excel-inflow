#!/usr/bin/env python3
"""Independently verify and aggregate broker whole-surface census artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compile_census(bundle: dict[str, Any], bundle_root: Path) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    surfaces: list[dict[str, Any]] = []
    artifact_root = Path(bundle.get("artifact_root") or bundle_root)
    for document in bundle.get("documents", []):
        artifacts = {item.get("artifact_id"): item for item in document.get("artifacts", [])}
        for surface in document.get("surfaces", []):
            artifact_id = surface.get("surface_census_artifact_id")
            artifact = artifacts.get(artifact_id)
            context = {"document_id": document.get("document_id"), "surface_id": surface.get("surface_id")}
            if not artifact or artifact.get("kind") != "surface_census":
                findings.append({"id": "broker_census.artifact_missing", "severity": "blocker", **context, "message": "Surface census artifact is missing."})
                continue
            path = artifact_root / str(artifact.get("path"))
            if not path.is_file() or sha256_file(path) != artifact.get("sha256"):
                findings.append({"id": "broker_census.artifact_hash_mismatch", "severity": "blocker", **context, "message": "Surface census artifact is missing or hash-invalid."})
                continue
            census = json.loads(path.read_text("utf-8"))
            if census.get("schema_version") != "broker-surface-census/1.0" or census.get("surface_id") != surface.get("surface_id"):
                findings.append({"id": "broker_census.binding_invalid", "severity": "blocker", **context, "message": "Surface census has an invalid schema or surface binding."})
                continue
            source_tokens = census.get("source_numeric_tokens")
            if source_tokens is None and census.get("source_cells") is not None:
                source_tokens = [cell for cell in census.get("source_cells", []) if cell.get("numeric_token") is not None]
            source_tokens = source_tokens or []
            declared_count = census.get("whole_surface_numeric_token_count")
            if declared_count is None and surface.get("vision_source_census"):
                source_tokens = surface["vision_source_census"].get("source_numeric_tokens", [])
                declared_count = surface.get("whole_surface_numeric_token_count")
            if declared_count is not None and declared_count != len(source_tokens):
                findings.append({"id": "broker_census.denominator_mismatch", "severity": "blocker", **context, "message": "Whole-surface numeric denominator does not match source-owned token records."})
            lanes = census.get("table_discovery_lanes") or []
            if surface.get("kind") in {"pdf_page", "workbook_sheet"} and not lanes:
                findings.append({"id": "broker_census.discovery_lanes_missing", "severity": "blocker", **context, "message": "No table-discovery lane was recorded."})
            material = [
                region for region in census.get("uncovered_numeric_regions", [])
                if region.get("material")
                and region.get("disposition") not in {
                    "covered", "covered_by_vision", "verified_non_tabular",
                    "quarantined_evidence_only"
                }
            ]
            if material and surface.get("lane_status", {}).get("vision") not in {"required", "complete"}:
                findings.append({"id": "broker_census.material_region_unresolved", "severity": "blocker", **context, "message": "A material uncovered numeric region has no vision disposition."})
            surfaces.append({
                "document_id": document.get("document_id"),
                "surface_id": surface.get("surface_id"),
                "kind": census.get("kind"),
                "whole_surface_numeric_token_count": declared_count,
                "nonblank_cell_count": census.get("nonblank_cell_count"),
                "discovery_lane_count": len(lanes),
                "uncovered_numeric_region_count": len(census.get("uncovered_numeric_regions", [])),
                "material_uncovered_region_count": len(material),
                "vision_status": surface.get("lane_status", {}).get("vision"),
                "census_sha256": artifact.get("sha256"),
            })
    unresolved = sum(1 for item in surfaces if item["vision_status"] == "required")
    report = {
        "schema_version": "broker-surface-census-report/1.0",
        "run_id": bundle.get("run_id"),
        "source_bundle_sha256": hashlib.sha256(canonical_bytes(bundle)).hexdigest(),
        "surfaces": surfaces,
        "findings": findings,
        "gate_status": "BLOCKED" if findings else ("NEEDS_VISION" if unresolved else "PASS"),
        "summary": {
            "surface_count": len(surfaces),
            "whole_surface_numeric_token_count": sum(int(item["whole_surface_numeric_token_count"] or 0) for item in surfaces),
            "uncovered_numeric_region_count": sum(item["uncovered_numeric_region_count"] for item in surfaces),
            "material_uncovered_region_count": sum(item["material_uncovered_region_count"] for item in surfaces),
            "unresolved_surface_count": unresolved,
            "finding_count": len(findings),
        },
    }
    report["report_sha256"] = hashlib.sha256(canonical_bytes(report)).hexdigest()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    input_path = Path(args.bundle).resolve()
    output_path = Path(args.out).resolve()
    bundle = json.loads(input_path.read_text("utf-8"))
    report = compile_census(bundle, input_path.parent)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(canonical_bytes(report))
    print(json.dumps({"status": report["gate_status"], **report["summary"]}, sort_keys=True))
    return 0 if report["gate_status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
